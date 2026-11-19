import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TEXT_OVERLAY, TEXT_MAX_CHARS, TEXT_MAX_SIZE, TEXT_MIN_SIZE, TEXT_STROKE_COLOR, TEXT_STROKE_RATIO,
  drawText, moveText, normalizeText, textActive, textLayout,
} from '../src/text-overlay.ts'

const measure = (perChar = 10) => ({ font: '', measureText(s) { return { width: s.length * perChar } } })
const overlay = (extra = {}) => ({ ...DEFAULT_TEXT_OVERLAY, text: 'Hi', ...extra })

test('normalizeText falls back to defaults for garbage input', () => {
  for (const junk of [undefined, null, 42, 'hello', [], true, NaN]) {
    assert.deepEqual(normalizeText(junk), DEFAULT_TEXT_OVERLAY)
  }
  assert.deepEqual(normalizeText({}), DEFAULT_TEXT_OVERLAY)
  assert.deepEqual(normalizeText({ text: undefined, size: undefined, x: null, y: 'bad' }), DEFAULT_TEXT_OVERLAY)
})

test('normalizeText keeps a fresh object and never shares input references', () => {
  const source = overlay({ text: 'Clip', nested: { a: 1 } })
  const result = normalizeText(source)
  assert.notEqual(result, source)
  assert.deepEqual(result, {
    text: 'Clip', size: 0.07, x: 0.5, y: 0.5, color: '#ffffff', font: 'Segoe UI',
  })
  result.x = 0.9
  assert.equal(source.x, 0.5)
})

test('normalizeText coerces text and truncates at 160 characters', () => {
  assert.equal(normalizeText({ text: 123 }).text, '123')
  assert.equal(normalizeText({ text: ['a', 'b'] }).text, 'a,b')
  assert.equal(normalizeText({ text: 'x'.repeat(TEXT_MAX_CHARS + 40) }).text.length, TEXT_MAX_CHARS)
})

test('normalizeText clamps size into the allowed range', () => {
  assert.equal(normalizeText({ size: 999 }).size, TEXT_MAX_SIZE)
  assert.equal(normalizeText({ size: -5 }).size, TEXT_MIN_SIZE)
  assert.equal(normalizeText({ size: 0.123 }).size, 0.123)
  assert.equal(normalizeText({ size: NaN }).size, DEFAULT_TEXT_OVERLAY.size)
  assert.equal(normalizeText({ size: Infinity }).size, DEFAULT_TEXT_OVERLAY.size)
  assert.equal(normalizeText({ size: '0.5' }).size, DEFAULT_TEXT_OVERLAY.size)
})

test('normalizeText clamps x and y into 0..1', () => {
  assert.equal(normalizeText({ x: 5, y: -2 }).x, 1)
  assert.equal(normalizeText({ x: 5, y: -2 }).y, 0)
  assert.equal(normalizeText({ x: 0.25, y: 0.75 }).x, 0.25)
  assert.equal(normalizeText({ x: 0.25, y: 0.75 }).y, 0.75)
  assert.equal(normalizeText({ x: Infinity, y: NaN }).x, DEFAULT_TEXT_OVERLAY.x)
  assert.equal(normalizeText({ x: Infinity, y: NaN }).y, DEFAULT_TEXT_OVERLAY.y)
})

test('normalizeText accepts only valid colors and known fonts', () => {
  assert.equal(normalizeText({ color: '#AABBCC' }).color, '#AABBCC')
  for (const bad of ['red', '#abc', '#GGGGGG', '#1122334', 123, null]) {
    assert.equal(normalizeText({ color: bad }).color, DEFAULT_TEXT_OVERLAY.color)
  }
  assert.equal(normalizeText({ font: 'Impact' }).font, 'Impact')
  assert.equal(normalizeText({ font: 'Georgia' }).font, 'Georgia')
  for (const bad of ['Comic Sans', 'arial', 42, null]) {
    assert.equal(normalizeText({ font: bad }).font, DEFAULT_TEXT_OVERLAY.font)
  }
})

test('textActive ignores blank overlays', () => {
  assert.equal(textActive(undefined), false)
  assert.equal(textActive(null), false)
  assert.equal(textActive(overlay({ text: '' })), false)
  assert.equal(textActive(overlay({ text: '  \n \t ' })), false)
  assert.equal(textActive(overlay({ text: 'x' })), true)
  assert.equal(textActive(overlay({ text: '  x  ' })), true)
})

test('moveText clamps position and does not mutate the input', () => {
  const source = overlay({ x: 0.2, y: 0.3 })
  const moved = moveText(source, 5, -2)
  assert.deepEqual(moved, { ...source, x: 1, y: 0 })
  assert.equal(source.x, 0.2)
  assert.equal(source.y, 0.3)
  assert.notEqual(moved, source)
})

test('moveText ignores non-finite pointer values', () => {
  const source = overlay({ x: 0.4, y: 0.6 })
  assert.deepEqual(moveText(source, NaN, Infinity), { ...source, x: 0.4, y: 0.6 })
  assert.deepEqual(moveText(source, -Infinity, undefined), { ...source, x: 0.4, y: 0.6 })
})

test('textLayout returns null for an inactive overlay', () => {
  assert.equal(textLayout(measure(), overlay({ text: '' }), 'landscape'), null)
  assert.equal(textLayout(measure(), overlay({ text: '  ' }), 'portrait'), null)
})

test('textLayout centers a single line and sets the exact font before measuring', () => {
  const ctx = measure()
  const seen = []
  ctx.measureText = function (s) { seen.push(this.font); return { width: s.length * 10 } }
  const size = 1920 * 0.1
  const layout = textLayout(ctx, overlay({ text: 'Hi', size: 0.1, font: 'Arial' }), 'landscape')
  assert.deepEqual(layout.lines, ['Hi'])
  assert.equal(layout.font, `700 ${size}px "Arial"`)
  assert.ok(seen.length > 0 && seen.every(font => font === layout.font))
  assert.equal(layout.size, size)
  assert.equal(layout.step, size * 1.2)
  assert.equal(layout.width, 20)
  assert.equal(layout.height, Math.ceil(size * 1.2))
  assert.equal(layout.x, Math.round(1920 * 0.5 - 10))
  assert.equal(layout.y, Math.round(1080 * 0.5 - layout.height / 2))
})

test('textLayout clamps the block inside the frame at the edges', () => {
  const layout = textLayout(measure(), overlay({ text: 'Hi', size: 0.1, x: 2, y: -1 }), 'landscape')
  assert.equal(layout.x, 1920 - layout.width)
  assert.equal(layout.y, 0)
})

test('textLayout uses portrait dimensions', () => {
  const layout = textLayout(measure(), overlay({ text: 'Hi', size: 0.1 }), 'portrait')
  assert.equal(layout.size, 1080 * 0.1)
  assert.equal(layout.x, Math.round(1080 * 0.5 - layout.width / 2))
  assert.equal(layout.y, Math.round(1920 * 0.5 - layout.height / 2))
})

test('textLayout wraps whitespace tokens at 90% of the frame width', () => {
  const layout = textLayout(measure(200), overlay({ text: 'hello world', size: 0.07 }), 'landscape')
  assert.deepEqual(layout.lines, ['hello', 'world'])
  assert.equal(layout.width, 1000)
  assert.equal(layout.height, Math.ceil(2 * layout.step))
})

test('textLayout force-splits an over-long token instead of overflowing', () => {
  const layout = textLayout(measure(), overlay({ text: 'a'.repeat(200), size: 0.1 }), 'landscape')
  assert.equal(layout.lines.length, 2)
  assert.equal(layout.lines[0].length, 172) // 1920 * 0.9 / 10 per char
  assert.equal(layout.lines[1].length, 28)
  assert.ok(layout.lines.every(line => line.length * 10 <= 1920 * 0.9))
  assert.equal(layout.width, 1720)
})

test('textLayout preserves empty paragraphs and computes multi-line height', () => {
  const layout = textLayout(measure(), overlay({ text: 'a\n\nb' }), 'landscape')
  assert.deepEqual(layout.lines, ['a', '', 'b'])
  assert.equal(layout.height, Math.ceil(3 * layout.step))
})

test('textLayout shrinks oversized text so every line stays inside the frame', () => {
  const many = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
  const layout = textLayout(measure(20), overlay({ text: many, size: TEXT_MAX_SIZE }), 'landscape')
  assert.ok(layout.width <= 1920 * 0.9 + 1, `width ${layout.width}`)
  assert.ok(layout.height <= 1080 * 0.9 + 1, `height ${layout.height}`)
  assert.ok(layout.size < 1920 * TEXT_MAX_SIZE)
  assert.ok(layout.x >= 0 && layout.x + layout.width <= 1920)
  assert.ok(layout.y >= 0 && layout.y + layout.height <= 1080)
  assert.equal(layout.lines.length, 20)
})

test('drawText strokes then fills each line at its centered baseline', () => {
  const calls = []
  const ctx = {
    font: '', textBaseline: '', textAlign: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
    strokeText(...args) { calls.push(['stroke', ...args]) },
    fillText(...args) { calls.push(['fill', ...args]) },
  }
  const layout = { x: 100, y: 200, width: 40, height: 20, font: '700 10px "Arial"', size: 10, step: 12, lines: ['aa', 'bb'] }
  drawText(ctx, layout, overlay({ color: '#cefa72' }))
  assert.equal(ctx.font, layout.font)
  assert.equal(ctx.textBaseline, 'middle')
  assert.equal(ctx.textAlign, 'left')
  assert.equal(ctx.lineJoin, 'round')
  assert.equal(ctx.lineWidth, 10 * TEXT_STROKE_RATIO)
  assert.equal(ctx.strokeStyle, TEXT_STROKE_COLOR)
  assert.equal(ctx.fillStyle, '#cefa72')
  assert.deepEqual(calls, [
    ['stroke', 'aa', 100, 204], ['fill', 'aa', 100, 204],
    ['stroke', 'bb', 100, 216], ['fill', 'bb', 100, 216],
  ])
})
