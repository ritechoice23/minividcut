import { invoke } from '@tauri-apps/api/core'
import { captionDimensions, captionLayouts, captionSequence, renderCaptionSprite } from './caption-artwork'
import type { CaptionState } from './captions'
import type { CaptionCue, CaptionFormat, CaptionTrack } from './captions'
import { drawText, textActive, textLayout } from './text-overlay'
import type { TextOverlay } from './text-overlay'

// Caption PNGs can be large for word-by-word styling. Two in flight keeps the
// parallel speed-up while bounding peak memory to roughly two overlay budgets.
const RENDER_CONCURRENCY = 2
const MAX_ARTWORK_BYTES = 64 * 1024 * 1024

function png(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new Error('Could not render caption artwork.'))
  }, 'image/png'))
}

/**
 * Render captions and the optional static text overlay into one cropped sprite
 * sequence. The Rust side only sees an x/y/PNG overlay, so text needs no export
 * changes: it shares the caption artwork's preview-exact rendering path.
 */
export async function prepareCaptionOverlay(
  track: CaptionTrack | undefined,
  text: TextOverlay | null | undefined,
  format: CaptionFormat,
  duration: number,
  canceled: () => boolean,
) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not open the caption renderer.')

  const active = textActive(text) ? text : null
  const states = track ? captionSequence(track.cues, track.style.mode ?? 'phrase', track.style.syncMs) : []
  const layoutFor = track ? captionLayouts(context, track.cues, track.style, format) : null
  // Measured on the unresized context; textLayout only uses font + measureText,
  // so the result stays valid after the canvas is sized below.
  const textBox = active ? textLayout(context, active, format) : null
  if (!states.length && !textBox) return undefined

  // Keep every variant inside one shared region. FFmpeg decodes a sprite only
  // when the displayed artwork changes, independent of the source frame rate.
  let x = Infinity, y = Infinity, right = 0, bottom = 0
  for (const cue of new Set(states.map(state => state.cue))) {
    const { box } = layoutFor!(cue)
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  if (textBox) {
    // Leave room for the outer half of the text stroke so the exported PNG
    // matches the full-frame preview instead of clipping the outline.
    const pad = Math.ceil(textBox.size * 0.08)
    x = Math.min(x, textBox.x - pad)
    y = Math.min(y, textBox.y - pad)
    right = Math.max(right, textBox.x + textBox.width + pad)
    bottom = Math.max(bottom, textBox.y + textBox.height + pad)
  }
  if (!Number.isFinite(x)) { x = 0; y = 0; right = 0; bottom = 0 }
  const { width: frameWidth, height: frameHeight } = captionDimensions(format)
  x -= x % 2
  y -= y % 2
  canvas.width = Math.max(2, Math.ceil((right - x) / 2) * 2)
  canvas.height = Math.max(2, Math.ceil((bottom - y) / 2) * 2)
  // FFmpeg rejects an overlay that extends past the video frame. Rounding up to
  // even dimensions can add a pixel, so pull the cropped region back inside.
  x = Math.max(0, Math.min(x, frameWidth - canvas.width))
  y = Math.max(0, Math.min(y, frameHeight - canvas.height))
  canvas.width = Math.min(canvas.width, frameWidth)
  canvas.height = Math.min(canvas.height, frameHeight)
  if (canceled()) return undefined

  const ink = (surface: HTMLCanvasElement) => surface.getContext('2d')
  // Text is static and drawn on top of every variant, including the empty one.
  // Its layout is in frame coordinates, so shift it into the cropped sprite.
  const paintText = (surfaceInk: CanvasRenderingContext2D) => {
    if (textBox && active) drawText(surfaceInk, { ...textBox, x: textBox.x - x, y: textBox.y - y }, active)
  }

  // Each cue variant gets one PNG. Rendering them in batches lets the browser
  // encode several small canvases concurrently instead of awaiting toBlob one
  // at a time, which dominates preparation for word-by-word captions.
  const variants: CaptionState[] = []
  const variantIndex = new Map<CaptionCue, Map<number, number>>()
  for (const state of states) {
    let indices = variantIndex.get(state.cue)
    if (!indices) {
      indices = new Map()
      variantIndex.set(state.cue, indices)
    }
    if (!indices.has(state.active)) {
      indices.set(state.active, variants.length + 1)
      variants.push(state)
    }
  }

  paintText(context)
  const images: Blob[] = [await png(canvas)]
  let imageBytes = images[0].size
  for (let offset = 0; offset < variants.length; offset += RENDER_CONCURRENCY) {
    if (canceled()) return undefined
    const batch = variants.slice(offset, offset + RENDER_CONCURRENCY)
    const rendered = await Promise.all(batch.map(async state => {
      const sprite = document.createElement('canvas')
      const spriteInk = ink(sprite)
      const surface = document.createElement('canvas')
      surface.width = canvas.width
      surface.height = canvas.height
      const surfaceInk = ink(surface)
      if (!spriteInk || !surfaceInk) throw new Error('Could not render caption artwork.')
      const layout = layoutFor!(state.cue)
      renderCaptionSprite(sprite, spriteInk, layout, state, track!.style)
      surfaceInk.drawImage(sprite, layout.box.x - x, layout.box.y - y)
      paintText(surfaceInk)
      return png(surface)
    }))
    for (const image of rendered) {
      imageBytes += image.size
      if (imageBytes > MAX_ARTWORK_BYTES) throw new Error('Caption artwork is too large. Export a shorter clip.')
      images.push(image)
    }
  }
  if (canceled()) return undefined

  const frames: { at: number; image: number }[] = []
  const durationMs = Math.max(1, Math.round(duration * 1000))
  let cursor = 0
  for (const state of states) {
    const start = Math.max(cursor, Math.round(state.start * 1000))
    const end = Math.min(durationMs, Math.round(state.end * 1000))
    if (end <= start) continue
    if (start > cursor) frames.push({ at: cursor, image: 0 })
    const image = variantIndex.get(state.cue)!.get(state.active)!
    if (frames.at(-1)?.image !== image) frames.push({ at: start, image })
    cursor = end
  }
  // A caption must stop at its own end, not at the end of the clip: emit a
  // text-only frame at `cursor` first, then hold that frame until the clip ends.
  if (!frames.length && !textBox) return undefined
  if (!frames.length) frames.push({ at: 0, image: 0 })
  if (cursor > frames.at(-1)!.at) frames.push({ at: cursor, image: 0 })
  frames.push({ at: Math.max(durationMs, frames.at(-1)!.at + 1), image: 0 })
  if (frames.length > 36_000) throw new Error('Too many caption changes. Export a shorter clip.')

  const metadata = new TextEncoder().encode(JSON.stringify({
    x, y, width: canvas.width, height: canvas.height,
    frames, sizes: images.map(image => image.size),
  }))
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, metadata.length, true)
  const buffers = await Promise.all(images.map(image => image.arrayBuffer()))
  const payload = new Uint8Array(4 + metadata.length + buffers.reduce((total, buffer) => total + buffer.byteLength, 0))
  payload.set(header, 0)
  payload.set(metadata, 4)
  let offset = 4 + metadata.length
  for (const buffer of buffers) {
    payload.set(new Uint8Array(buffer), offset)
    offset += buffer.byteLength
  }
  return invoke<string>('prepare_caption_overlay', payload)
}
