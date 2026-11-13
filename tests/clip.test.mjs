import assert from 'node:assert/strict'
import test from 'node:test'
import { cutRange, moveBoundary, parseTime, splitRange, stamp, trimClips, validRange } from '../src/clip.ts'

test('accepts seconds and timecodes with millisecond precision', () => {
  assert.equal(parseTime('1:02:03.456'), 3723.456)
  assert.equal(parseTime('62.5'), 62.5)
  assert.equal(parseTime('1:02.5'), 62.5)
  assert.equal(stamp(3723.456, true), '01:02:03.456')
  assert.equal(stamp(59.9999, true), '00:01:00.000')
  for (const value of ['', '-2', '1:65', '1:65:00', '1e2', '0.0001']) assert.ok(Number.isNaN(parseTime(value)))
})

test('rejects invalid trim bounds', () => {
  assert.ok(validRange({ start: 3, end: 3.05 }, 5))
  assert.ok(!validRange({ start: 3, end: 3.04 }, 5))
  assert.ok(!validRange({ start: 3, end: 5.01 }, 5))
  assert.ok(!validRange({ start: NaN, end: 5 }, 5))
})

test('places the requested marker at the playhead on either side of the other marker', () => {
  const range = { start: 2, end: 4 }
  assert.deepEqual(moveBoundary(range, 'start', 3, 10), { start: 3, end: 4 })
  assert.deepEqual(moveBoundary(range, 'start', 7, 10), { start: 7, end: 7.05 })
  assert.deepEqual(moveBoundary(range, 'end', 1, 10), { start: 0.95, end: 1 })
  assert.deepEqual(moveBoundary(range, 'start', 10, 10), { start: 10, end: 10 })
  assert.deepEqual(moveBoundary(range, 'end', 0, 10), { start: 0, end: 0 })
  assert.equal(moveBoundary(range, 'end', 10.01, 10), null)
  assert.equal(moveBoundary(range, 'start', NaN, 10), null)
})

test('splits the active range without a tiny trailing clip', () => {
  assert.deepEqual(splitRange({ start: 12, end: 44 }, 15), [
    { start: 12, end: 27 }, { start: 27, end: 42 }, { start: 42, end: 44 },
  ])
  assert.deepEqual(splitRange({ start: 0, end: 30.01 }, 15), [
    { start: 0, end: 15 }, { start: 15, end: 30.01 },
  ])
  assert.equal(splitRange({ start: 0, end: 1600 }, 15), null)
})
test('cuts a middle, edge, or entire section while dropping unusably short remnants', () => {
  const clip = { start: 1, end: 10 }
  assert.deepEqual(cutRange(clip, { start: 3, end: 7 }), [{ start: 1, end: 3 }, { start: 7, end: 10 }])
  assert.deepEqual(cutRange(clip, { start: 0, end: 4 }), [{ start: 4, end: 10 }])
  assert.deepEqual(cutRange(clip, { start: 4, end: 9.98 }), [{ start: 1, end: 4 }])
  assert.deepEqual(cutRange(clip, { start: 0, end: 11 }), [])
  assert.deepEqual(cutRange(clip, { start: 10, end: 11 }), [clip])
})

test('trimClips trims out any part of the timeline or selected clips', () => {
  let id = 10
  const nextId = () => ++id

  // Trimming full video when clips are empty
  const fromEmpty = trimClips([], { start: 10, end: 20 }, 60, nextId)
  assert.deepEqual(fromEmpty, [
    { start: 0, end: 10, id: 11 },
    { start: 20, end: 60, id: 12 },
  ])

  // Trimming an already selected clip completely
  const existing = [
    { start: 0, end: 10, id: 1 },
    { start: 20, end: 40, id: 2, title: 'Scene 2' },
    { start: 50, end: 60, id: 3 },
  ]
  const trimmedSelected = trimClips(existing, { start: 20, end: 40 }, 60, nextId)
  assert.deepEqual(trimmedSelected, [
    { start: 0, end: 10, id: 1 },
    { start: 50, end: 60, id: 3 },
  ])

  // Trimming a part of an unselected or selected clip
  const trimmedPart = trimClips(existing, { start: 25, end: 35 }, 60, nextId)
  assert.deepEqual(trimmedPart, [
    { start: 0, end: 10, id: 1 },
    { start: 20, end: 25, id: 2, title: 'Scene 2', captions: undefined },
    { start: 35, end: 40, id: 13, title: 'Scene 2 - Part 2', captions: undefined },
    { start: 50, end: 60, id: 3 },
  ])

  // Trimming across multiple clips on the timeline
  const trimmedAcross = trimClips(existing, { start: 8, end: 25 }, 60, nextId)
  assert.deepEqual(trimmedAcross, [
    { start: 0, end: 8, id: 1, title: undefined, captions: undefined },
    { start: 25, end: 40, id: 2, title: 'Scene 2', captions: undefined },
    { start: 50, end: 60, id: 3 },
  ])
})
