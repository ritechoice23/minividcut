import { invoke } from '@tauri-apps/api/core'
import { captionLayouts, captionSequence, renderCaptionSprite } from './caption-artwork'
import type { CaptionState } from './captions'
import type { CaptionFormat, CaptionTrack } from './captions'

function png(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new Error('Could not render caption artwork.'))
  }, 'image/png'))
}

export async function prepareCaptionOverlay(track: CaptionTrack, format: CaptionFormat, duration: number) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  const sprite = document.createElement('canvas')
  const ink = sprite.getContext('2d')
  if (!context || !ink) throw new Error('Could not open the caption renderer.')
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
  const images = [await png(canvas)]
  let imageBytes = images[0].size
  const frames: { at: number; image: number }[] = []
  const cache = new Map<CaptionState['cue'], Map<number, number>>()
  const durationMs = Math.round(duration * 1000)
  let cursor = 0
  for (const state of states) {
    const start = Math.max(cursor, Math.round(state.start * 1000))
    const end = Math.min(durationMs, Math.round(state.end * 1000))
    if (end <= start) continue
    if (start > cursor) frames.push({ at: cursor, image: 0 })
    const image = await render(state)
    if (frames.at(-1)?.image !== image) frames.push({ at: start, image })
    cursor = end
  }
  if (!frames.length) return undefined
  frames.push({ at: cursor, image: 0 })
  if (frames.length > 36_000) throw new Error('Too many caption changes. Export a shorter clip.')
  const metadata = new TextEncoder().encode(JSON.stringify({ x, y, width: canvas.width, height: canvas.height, frames, sizes: images.map(image => image.size) }))
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, metadata.length, true)
  return invoke<string>('prepare_caption_overlay', await new Blob([header, metadata, ...images]).arrayBuffer())

  async function render(state: CaptionState) {
    const variants = cache.get(state.cue) ?? new Map<number, number>()
    const existing = variants.get(state.active)
    if (existing !== undefined) return existing
    const layout = layoutFor(state.cue)
    context!.clearRect(0, 0, canvas.width, canvas.height)
    renderCaptionSprite(sprite, ink!, layout, state, track.style)
    context!.drawImage(sprite, layout.box.x - x, layout.box.y - y)
    const index = images.length
    const image = await png(canvas)
    imageBytes += image.size
    if (imageBytes > 125 * 1024 * 1024) throw new Error('Caption artwork is too large. Export a shorter clip.')
    images.push(image)
    variants.set(state.active, index)
    cache.set(state.cue, variants)
    return index
  }
}
