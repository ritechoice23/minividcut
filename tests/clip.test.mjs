import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTime, splitRange, stamp, validRange } from '../src/clip.ts'

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

test('splits the active range without a tiny trailing clip', () => {
  assert.deepEqual(splitRange({ start: 12, end: 44 }, 15), [
    { start: 12, end: 27 }, { start: 27, end: 42 }, { start: 42, end: 44 },
  ])
  assert.deepEqual(splitRange({ start: 0, end: 30.01 }, 15), [
    { start: 0, end: 15 }, { start: 15, end: 30.01 },
  ])
  assert.equal(splitRange({ start: 0, end: 1600 }, 15), null)
})
