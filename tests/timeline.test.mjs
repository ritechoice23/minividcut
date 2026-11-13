import assert from 'node:assert/strict'
import test from 'node:test'
import { panTimeline, timelineWindow, zoomTimeline, timelineTime } from '../src/timeline.ts'

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
