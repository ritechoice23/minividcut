import assert from 'node:assert/strict'
import test from 'node:test'
import { activeLook, applyLook, CAPTION_LOOKS } from '../src/caption-looks.ts'

const base = { preset: 'classic', position: 'bottom', size: 'medium', scale: 1.1, accent: '#ff0000' }

test('applying a look keeps placement, size and colours', () => {
  for (const look of CAPTION_LOOKS) {
    const styled = applyLook(base, look)
    assert.equal(styled.position, 'bottom')
    assert.equal(styled.scale, 1.1)
    assert.equal(styled.accent, '#ff0000')
    assert.equal(activeLook(styled)?.id, look.id)
  }
})

test('a style without explicit mode or case reads as the Classic look', () => {
  assert.equal(activeLook(base)?.id, 'classic')
})

test('a hand-customized style matches no look', () => {
  assert.equal(activeLook({ ...base, mode: 'word', case: 'upper' }), undefined)
})

test('every look has a unique id and label', () => {
  assert.equal(new Set(CAPTION_LOOKS.map(look => look.id)).size, CAPTION_LOOKS.length)
  assert.equal(new Set(CAPTION_LOOKS.map(look => look.label)).size, CAPTION_LOOKS.length)
})
