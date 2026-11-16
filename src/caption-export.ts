import { invoke } from '@tauri-apps/api/core'
import { captionLayouts, captionSequence, renderCaptionSprite } from './caption-artwork'
import type { CaptionState } from './captions'
import type { CaptionFormat, CaptionCue, CaptionTrack } from './captions'

const RENDER_CONCURRENCY = 6

function png(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new Error('Could not render caption artwork.'))
  }, 'image/png'))
}

export async function prepareCaptionOverlay(track: CaptionTrack, format: CaptionFormat, duration: number, canceled: () => boolean) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not open the caption renderer.')
  const states = captionSequence(track.cues, track.style.mode ?? 'phrase', track.style.syncMs)
  const layoutFor = captionLayouts(context, track.cues, track.style, format)
  if (!states.length) return undefined

  // Keep sprites cropped to one shared region. FFmpeg decodes a sprite only
  // when the displayed caption changes, independent of the source frame rate.
  let x = Infinity, y = Infinity, right = 0, bottom = 0
  for (const cue of new Set(states.map(state => state.cue))) {
    const { box } = layoutFor(cue)
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  x -= x % 2
  y -= y % 2
  canvas.width = Math.ceil((right - x) / 2) * 2
  canvas.height = Math.ceil((bottom - y) / 2) * 2
  if (canceled()) return undefined

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

  const images: Blob[] = [await png(canvas)]
  let imageBytes = images[0].size
  const ink = (surface: HTMLCanvasElement) => surface.getContext('2d')
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
      const layout = layoutFor(state.cue)
      renderCaptionSprite(sprite, spriteInk, layout, state, track.style)
      surfaceInk.drawImage(sprite, layout.box.x - x, layout.box.y - y)
      return png(surface)
    }))
    for (const image of rendered) {
      imageBytes += image.size
      if (imageBytes > 125 * 1024 * 1024) throw new Error('Caption artwork is too large. Export a shorter clip.')
      images.push(image)
    }
  }
  if (canceled()) return undefined

  const frames: { at: number; image: number }[] = []
  const durationMs = Math.round(duration * 1000)
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
  if (!frames.length) return undefined
  frames.push({ at: cursor, image: 0 })
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
