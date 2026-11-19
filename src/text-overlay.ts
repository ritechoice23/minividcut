import type { CaptionFormat } from './captions'

// Mirrors captionDimensions() from caption-artwork.ts. Inlined so this module
// stays importable by the native-TS test runner (that file's own imports are
// extensionless and cannot be resolved when loaded directly as .ts).
const frameDimensions = (format: CaptionFormat) => format === 'portrait'
  ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }

export const TEXT_FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Impact'] as const
export type TextFont = typeof TEXT_FONTS[number]

export type TextOverlay = {
  id: string     // stable identity for list editing (always non-empty on real overlays)
  text: string
  size: number   // fraction of frame WIDTH used as font size, e.g. 0.07 -> 134px at 1920 wide
  x: number      // normalized 0..1, center of the text block
  y: number      // normalized 0..1, center of the text block
  color: string  // #rrggbb
  font: TextFont
}

export const DEFAULT_TEXT_OVERLAY: TextOverlay = {
  id: '', text: '', size: 0.07, x: 0.5, y: 0.5, color: '#ffffff', font: 'Segoe UI',
}
export const TEXT_MIN_SIZE = 0.03
export const TEXT_MAX_SIZE = 0.2
export const TEXT_MAX_CHARS = 4000
export const TEXT_MAX_LAYERS = 50
export const TEXT_STROKE_COLOR = '#101010'
export const TEXT_STROKE_RATIO = 0.1   // stroke line width = size * this

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u

let idCounter = 0

/** Generate a non-empty identity. Uses the platform UUID when available and a
 *  deterministic counter otherwise so the module also works in bare Node tests. */
function freshId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const uuid = cryptoRef?.randomUUID?.()
  if (typeof uuid === 'string' && uuid.length > 0) return uuid
  idCounter += 1
  return `text-${idCounter}`
}

export function createTextOverlay(): TextOverlay {
  return { ...DEFAULT_TEXT_OVERLAY, id: freshId(), text: '' }
}

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
    const rawId = input.id
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : freshId()
    return {
      id,
      text: String(input.text ?? '').slice(0, TEXT_MAX_CHARS),
      size: number('size', DEFAULT_TEXT_OVERLAY.size, TEXT_MIN_SIZE, TEXT_MAX_SIZE),
      x: number('x', DEFAULT_TEXT_OVERLAY.x, 0, 1),
      y: number('y', DEFAULT_TEXT_OVERLAY.y, 0, 1),
      color,
      font,
    }
  } catch {
    return { ...DEFAULT_TEXT_OVERLAY, id: freshId() }
  }
}

export function normalizeTexts(value: unknown): TextOverlay[] {
  try {
    // v1.1.0 stored a single overlay object; migrate it into a one-item list.
    const entries: unknown[] = Array.isArray(value)
      ? value
      : value && typeof value === 'object' ? [value] : []
    const seen = new Set<string>()
    const result: TextOverlay[] = []
    const fields = ['id', 'text', 'size', 'x', 'y', 'color', 'font']
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      // Keep empty blocks so the user can type into a freshly added layer;
      // inactive text is filtered out only when artwork is prepared.
      if (!fields.some(field => field in entry)) continue
      const overlay = normalizeText(entry)
      if (seen.has(overlay.id)) continue
      seen.add(overlay.id)
      result.push(overlay)
      if (result.length >= TEXT_MAX_LAYERS) break
    }
    return result
  } catch {
    return []
  }
}

/** Convert a v1.1.0 single-overlay record once, giving its text a stable id. */
export function migrateLegacyText<T extends { texts?: TextOverlay[]; text?: TextOverlay }>(clip: T): T {
  if (clip.texts || !clip.text) return clip
  const { text, ...rest } = clip
  return { ...rest, texts: normalizeTexts(text) } as T
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
  // Keep a small margin so the final block stays comfortably inside the frame
  // even after rounding (<= 91% of each dimension).
  const safeWidth = width * 0.91
  const safeHeight = height * 0.91

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
  for (let attempt = 0; attempt < 12 &&
    (result.blockWidth > limitWidth || result.blockHeight > limitHeight); attempt++) {
    const scale = Math.min(1, limitWidth / Math.max(1, result.blockWidth),
      limitHeight / Math.max(1, result.blockHeight)) * 0.97
    size = Math.max(2, size * scale)
    result = layoutAt(size)
  }

  let { font, step, lines, blockWidth, blockHeight } = result
  if (lines.length * step > safeHeight) {
    // Thousands of blank paragraphs cannot be fixed by font shrinking alone.
    // Compress the line spacing so every baseline lands inside the picture.
    step = safeHeight / lines.length
    size = Math.min(size, step / 1.2)
    font = `700 ${size}px "${overlay.font}"`
    ctx.font = font
    blockWidth = Math.ceil(Math.max(0, ...lines.map(line => ctx.measureText(line).width)))
    blockHeight = Math.ceil(lines.length * step)
  }
  const boxWidth = Math.min(safeWidth, blockWidth)
  const boxHeight = Math.min(safeHeight, blockHeight)
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
