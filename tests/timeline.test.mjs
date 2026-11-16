import assert from 'node:assert/strict'
import test from 'node:test'
import { panTimeline, snapTime, timelineFrames, timelineOverlaps, timelineWindow, zoomAround, zoomTimeline, timelineTime } from '../src/timeline.ts'

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

test('zoom keeps the time under the cursor in place and clamps at both ends', () => {
  assert.equal(zoomAround(120, 4, 45, 0.5), 30)
  assert.equal(zoomAround(120, 4, 45, 0), 45)
  assert.equal(zoomAround(120, 4, 45, 1), 15)
  assert.equal(zoomAround(120, 4, 118, 0.5), 90)
  assert.equal(zoomAround(120, 4, 2, 0.5), 0)
})

test('snaps to the nearest edit point within a tolerance', () => {
  const points = [0, 4, 8, 12]
  assert.equal(snapTime(4.2, points, 0.5), 4)
  assert.equal(snapTime(5.1, points, 0.5), 5.1)
  assert.equal(snapTime(11.9, points, 0.5), 12)
  assert.equal(snapTime(4.2, [Number.NaN, 4], 0.5), 4)
})

test('pans by the visible time span and stops at the ends', () => {
  assert.equal(panTimeline(120, 4, 45, 0.5), 60)
  assert.equal(panTimeline(120, 4, 45, -0.5), 30)
  assert.equal(panTimeline(120, 4, 45, -10), 0)
  assert.equal(panTimeline(120, 4, 45, 10), 90)
})
