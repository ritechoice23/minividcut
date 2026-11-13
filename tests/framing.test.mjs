import assert from 'node:assert/strict'
import test from 'node:test'
import { frameTravel, panPosition } from '../src/framing.ts'

test('dragging an oversize Fill image reveals the opposite edge', () => {
  const travel = frameTravel(160, 90, 160 / 90, 'fill')
  assert.deepEqual(travel, { x: 0, y: 0 })
  const portrait = frameTravel(90, 160, 160 / 90, 'fill')
  assert.ok(portrait.x < 0)
  assert.equal(portrait.y, 0)
  assert.deepEqual(panPosition({ x: 50, y: 50 }, portrait, -portrait.x / 2, 50), { x: 0, y: 50 })
  assert.equal(panPosition({ x: 50, y: 50 }, portrait, -1000, 0).x, 100)
})

test('Fit moves the picture through the available space without cropping', () => {
  const portrait = frameTravel(90, 160, 16 / 9, 'fit')
  assert.equal(portrait.x, 0)
  assert.ok(portrait.y > 0)
  assert.deepEqual(panPosition({ x: 50, y: 50 }, portrait, 50, portrait.y / 2), { x: 50, y: 100 })
})
