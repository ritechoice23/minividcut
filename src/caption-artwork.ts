import { CAPTION_ACCENT, CAPTION_STROKE, CAPTION_SYNC_MS, captionDisplayText, captionStates, captionStroke } from './captions'
import type { CaptionCue, CaptionFormat, CaptionState, CaptionStyle } from './captions'

export const captionDimensions = (format: CaptionFormat) => format === 'portrait'
  ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }

export function captionPoint(style: CaptionStyle, format: CaptionFormat) {
  return style.points?.[format] ?? { x: 0.5, y: style.position === 'top' ? 0.14
    : style.position === 'middle' ? 0.5 : format === 'portrait' ? 0.8 : 0.86 }
}

type Box = { x: number; y: number; width: number; height: number }
type Run = { text: string; x: number; width: number; index: number }
type Line = { text: string; runs: Run[]; width: number }
type Layout = { box: Box; lines: Line[]; font: string; size: number; step: number }
type Context = CanvasRenderingContext2D

function captionLayout(context: Context, text: string, style: CaptionStyle, format: CaptionFormat): Layout {
  const { width, height } = captionDimensions(format)
  const point = captionPoint(style, format)
  const size = width * (format === 'portrait' ? 0.059 : 0.037) * (style.scale ??
    (style.size === 'small' ? 0.81 : style.size === 'large' ? 1.25 : 1))
  const family = style.font ?? (style.preset === 'serif' ? 'Georgia' : 'Arial')
  const font = `${family === 'Georgia' || family === 'Impact' ? 400 : 700} ${size}px "${family}"`
  context.font = font
  const measure = (text: string) => context.measureText(text).width
  const pad = size * 0.3
  const maxWidth = width * 0.92 - pad * 2
  const lines: Line[] = []
  let index = 0
  for (const paragraph of text.split(/\r?\n/u)) {
    let line: Line = { text: '', runs: [], width: 0 }
    for (const token of paragraph.match(/\S+/gu) ?? []) {
      // Split long unbroken tokens without losing their spoken-word index.
      let pieces = [token]
      if (measure(token) > maxWidth) {
        pieces = []
        let piece = ''
        for (const letter of Array.from(token)) {
          if (piece && measure(piece + letter) > maxWidth) { pieces.push(piece); piece = '' }
          piece += letter
        }
        if (piece) pieces.push(piece)
      }
      pieces.forEach((piece, part) => {
        const next = line.text ? `${line.text} ${piece}` : piece
        if (part > 0 || (line.text && measure(next) > maxWidth)) {
          lines.push(line)
          line = { text: '', runs: [], width: 0 }
        }
        const prefix = line.text ? `${line.text} ` : ''
        line.runs.push({ text: piece, x: measure(prefix), width: measure(piece), index })
        line.text = prefix + piece
        line.width = measure(line.text)
      })
      index++
    }
    lines.push(line)
  }
  const step = size * 1.23
  const blockWidth = Math.ceil(Math.max(...lines.map(line => line.width)) + 2 * pad)
  const blockHeight = Math.ceil(lines.length * step + 2 * pad)
  const box = {
    x: Math.round(Math.max(0, Math.min(width - blockWidth, point.x * width - blockWidth / 2))),
    y: Math.round(Math.max(0, Math.min(height - blockHeight, point.y * height - blockHeight / 2))),
    width: Math.min(width, blockWidth), height: Math.min(height, blockHeight),
  }
  return { box, lines, font, size, step }
}

export function drawCaption(context: Context, layout: Layout, state: CaptionState, style: CaptionStyle, origin = { x: 0, y: 0 }) {
  const { box, lines, font, size, step } = layout
  const center = box.x + box.width / 2 - origin.x
  const y = box.y + box.height / 2 - origin.y
  context.font = font
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  const stroke = captionStroke(style)
  context.strokeStyle = style.strokeColor ?? CAPTION_STROKE
  if (stroke > 0) context.lineWidth = size * stroke / 100

  const lineArt = (text: string, width: number, baseline: number, runs: Run[]) => {
    if (!text) return
    const left = center - width / 2
    if (style.preset === 'boxed') {
      context.beginPath()
      context.roundRect(left - size * 0.18, baseline - step * 0.48, width + size * 0.36, step * 0.96, size * 0.12)
      context.fillStyle = '#101010d9'
      context.fill()
    }
    if (stroke > 0) context.strokeText(text, left, baseline)
    context.fillStyle = '#ffffff'
    context.fillText(text, left, baseline)
    const highlighted = state.mode === 'highlight' && runs.some(run => run.index === state.active)
    if (!highlighted) return
    // Repaint the same shaped line through the spoken word's bounds.
    const rtl = /^[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text)
    context.save()
    context.beginPath()
    for (const run of runs) {
      if (run.index !== state.active) continue
      const x = rtl ? width - run.x - run.width : run.x
      context.rect(left + x - size * 0.025, baseline - step, run.width + size * 0.05, step * 2)
    }
    context.clip()
    context.fillStyle = style.accent ?? CAPTION_ACCENT
    context.fillText(text, left, baseline)
    context.restore()
  }
  if (state.mode === 'word') {
    const rows = lines.flatMap(line => line.runs.filter(run => run.index === state.active))
    rows.forEach((run, index) => lineArt(run.text, run.width, y + (index - (rows.length - 1) / 2) * step, []))
  } else {
    lines.forEach((line, index) => lineArt(line.text, line.width, y + (index - (lines.length - 1) / 2) * step, line.runs))
  }
}

export function renderCaptionSprite(surface: HTMLCanvasElement, context: Context, layout: Layout, state: CaptionState, style: CaptionStyle) {
  surface.width = layout.box.width
  surface.height = layout.box.height
  drawCaption(context, layout, state, style, layout.box)
}

export function captionLayouts(context: Context, cues: CaptionCue[], style: CaptionStyle, format: CaptionFormat) {
  const layouts = new Map<CaptionCue, Layout>()
  const text = captionDisplayText(cues, style.case)
  const indices = new Map(cues.map((cue, index) => [cue, index]))
  return (cue: CaptionCue) => {
    let layout = layouts.get(cue)
    if (!layout) {
      layout = captionLayout(context, text[indices.get(cue) ?? -1] ?? cue.text, style, format)
      layouts.set(cue, layout)
    }
    return layout
  }
}

export const captionSequence = (cues: CaptionCue[], mode: CaptionState['mode'], syncMs = CAPTION_SYNC_MS) =>
  cues.flatMap(cue => captionStates(cue, mode, syncMs))
