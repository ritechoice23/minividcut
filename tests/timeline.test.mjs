import assert from 'node:assert/strict'
import test from 'node:test'
import { panTimeline, timelineFrames, timelineOverlaps, timelineWindow, zoomTimeline, timelineTime } from '../src/timeline.ts'

test('marks shared coverage without treating adjacent clips as overlapping', () => {
  assert.deepEqual(timelineOverlaps([
    { start: 8, end: 15 }, { start: 0, end: 10 }, { start: 9, end: 12 }, { start: 15, end: 20 },
  ]), [{ start: 8, end: 12 }])
})

test('keeps frame times anchored as the zoomed viewport pans', () => {
  const first = timelineFrames(120, 4, 30)
  const next = timelineFrames(120, 4, 31)
  assert.equal(first[0].time, next[0].time)
  assert.equal(first[0].left, 0)
  assert.ok(next[0].left < 0)
  assert.ok(timelineFrames(120, 4, 90).every(frame => frame.time < 120))
})

test('centers the zoom on the playhead and clamps to the video ends', () => {
  assert.equal(zoomTimeline(120, 4, 60), 45)
  assert.equal(zoomTimeline(120, 4, 118), 90)
  assert.equal(zoomTimeline(120, 4, 2), 0)
  assert.deepEqual(timelineWindow(120, 1, 45), { start: 0, end: 120, span: 120, maxStart: 0 })
})

test('maps pointer coordinates to time within the visible interval', () => {
  assert.equal(timelineTime(45, 30, 0.5), 60)
  assert.equal(timelineTime(45, 30, -1), 45)
  assert.equal(timelineTime(45, 30, 2), 75)
})

test('pans by the visible time span and stops at the ends', () => {
  assert.equal(panTimeline(120, 4, 45, 0.5), 60)
  assert.equal(panTimeline(120, 4, 45, -0.5), 30)
  assert.equal(panTimeline(120, 4, 45, -10), 0)
  assert.equal(panTimeline(120, 4, 45, 10), 90)
})
