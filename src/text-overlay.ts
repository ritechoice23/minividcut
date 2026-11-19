import type { CaptionFormat } from './captions'

// Mirrors captionDimensions() from caption-artwork.ts. Inlined so this module
// stays importable by the native-TS test runner (that file's own imports are
// extensionless and cannot be resolved when loaded directly as .ts).
const frameDimensions = (format: CaptionFormat) => format === 'portrait'
  ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }

export const TEXT_FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Impact'] as const
export type TextFont = typeof TEXT_FONTS[number]

export type TextOverlay = {
  text: string
  size: number   // fraction of frame WIDTH used as font size, e.g. 0.07 -> 134px at 1920 wide
  x: number      // normalized 0..1, center of the text block
  y: number      // normalized 0..1, center of the text block
  color: string  // #rrggbb
  font: TextFont
}

export const DEFAULT_TEXT_OVERLAY: TextOverlay = {
  text: '', size: 0.07, x: 0.5, y: 0.5, color: '#ffffff', font: 'Segoe UI',
}
export const TEXT_MIN_SIZE = 0.03
export const TEXT_MAX_SIZE = 0.2
export const TEXT_MAX_CHARS = 160
export const TEXT_STROKE_COLOR = '#101010'
export const TEXT_STROKE_RATIO = 0.1   // stroke line width = size * this

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u

export function normalizeText(value: unknown): TextOverlay {
  try {
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const number = (key: string, fallback: number, min: number, max: number) => {
      const raw = input[key]
      return typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(max, Math.max(min, raw)) : fallback
    }
    const color = typeof input.color === 'string' && COLOR_PATTERN.test(input.color)
      ? input.color : DEFAULT_TEXT_OVERLAY.color
    const font = typeof input.font === 'string' && (TEXT_FONTS as readonly string[]).includes(input.font)
      ? input.font as TextFont : DEFAULT_TEXT_OVERLAY.font
    return {
      text: String(input.text ?? '').slice(0, TEXT_MAX_CHARS),
      size: number('size', DEFAULT_TEXT_OVERLAY.size, TEXT_MIN_SIZE, TEXT_MAX_SIZE),
      x: number('x', DEFAULT_TEXT_OVERLAY.x, 0, 1),
      y: number('y', DEFAULT_TEXT_OVERLAY.y, 0, 1),
      color,
      font,
    }
  } catch {
    return { ...DEFAULT_TEXT_OVERLAY }
  }
}

export function textActive(overlay?: TextOverlay | null): boolean {
  return !!overlay && typeof overlay.text === 'string' && overlay.text.trim().length > 0
}

export function moveText(overlay: TextOverlay, x: number, y: number): TextOverlay {
  const clamp = (value: number, fallback: number) => Number.isFinite(value)
    ? Math.min(1, Math.max(0, value)) : fallback
  return { ...overlay, x: clamp(x, overlay.x), y: clamp(y, overlay.y) }
}

export type TextLayout = {
  x: number
  y: number
  width: number
  height: number
  font: string
  size: number
  step: number
  lines: string[]
}

export function textLayout(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay,
  format: CaptionFormat,
): TextLayout | null {
  if (!textActive(overlay)) return null
  const { width, height } = frameDimensions(format)
  const limitWidth = width * 0.9
  const limitHeight = height * 0.9

  // A long or very large message must still fit inside the picture. Wrapping
  // depends on the font size, so re-lay out after shrinking until it fits.
  const layoutAt = (size: number) => {
    const font = `700 ${size}px "${overlay.font}"`
    ctx.font = font
    const measure = (text: string) => ctx.measureText(text).width
    const lines: string[] = []
    for (const paragraph of overlay.text.split(/\r?\n/u)) {
      let line = ''
      for (const token of paragraph.match(/\S+/gu) ?? []) {
        // Split long unbroken tokens character by character so they never overflow.
        let pieces = [token]
        if (measure(token) > limitWidth) {
          pieces = []
          let piece = ''
          for (const letter of Array.from(token)) {
            if (piece && measure(piece + letter) > limitWidth) { pieces.push(piece); piece = '' }
            piece += letter
          }
          if (piece) pieces.push(piece)
        }
        pieces.forEach((piece, part) => {
          if (part > 0 || (line && measure(`${line} ${piece}`) > limitWidth)) {
            lines.push(line)
            line = ''
          }
          line = line ? `${line} ${piece}` : piece
        })
      }
      lines.push(line) // Preserve empty paragraphs as empty lines.
    }
    const step = size * 1.2
    const blockWidth = Math.ceil(Math.max(0, ...lines.map(line => measure(line))))
    const blockHeight = Math.ceil(lines.length * step)
    return { font, step, lines, blockWidth, blockHeight }
  }

  let size = width * overlay.size
  let result = layoutAt(size)
  for (let attempt = 0; attempt < 5 &&
    (result.blockWidth > limitWidth || result.blockHeight > limitHeight); attempt++) {
    const scale = Math.min(1, limitWidth / Math.max(1, result.blockWidth),
      limitHeight / Math.max(1, result.blockHeight)) * 0.97
    size = Math.max(4, size * scale)
    result = layoutAt(size)
  }

  const { font, step, lines, blockWidth, blockHeight } = result
  const boxWidth = Math.min(width, blockWidth)
  const boxHeight = Math.min(height, blockHeight)
  const x = Math.round(Math.min(Math.max(0, width - boxWidth), Math.max(0, overlay.x * width - boxWidth / 2)))
  const y = Math.round(Math.min(Math.max(0, height - boxHeight), Math.max(0, overlay.y * height - boxHeight / 2)))
  return { x, y, width: boxWidth, height: boxHeight, font, size, step, lines }
}

export function drawText(ctx: CanvasRenderingContext2D, layout: TextLayout, overlay: TextOverlay): void {
  ctx.font = layout.font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  const lineWidth = layout.size * TEXT_STROKE_RATIO
  ctx.lineWidth = lineWidth
  ctx.strokeStyle = TEXT_STROKE_COLOR
  ctx.fillStyle = overlay.color
  layout.lines.forEach((line, index) => {
    const baseline = layout.y + layout.height / 2 + (index - (layout.lines.length - 1) / 2) * layout.step
    if (lineWidth > 0) ctx.strokeText(line, layout.x, baseline)
    ctx.fillText(line, layout.x, baseline)
  })
}
