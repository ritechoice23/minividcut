import assert from 'node:assert/strict'
import test from 'node:test'
import { activeTime, playbackClock, selectTimelineTime, useEditor } from '../src/editor-store.ts'

test('playback clock ignores non-finite values and cycles back to source time', () => {
  const store = useEditor.getState()
  store.setTime(12.5)
  playbackClock.set(Number.NaN)
  assert.equal(playbackClock.get(), 12.5)
  playbackClock.set(14)
  assert.equal(activeTime(), 14)
})

test('preview time maps transport actions to the source-equivalent time', () => {
  const store = useEditor.getState()
  store.setTime(30)
  store.setSequenceActive(true)
  store.setSequenceTime(2.5, 6, 11.25)
  assert.equal(activeTime(), 11.25)
  store.setSequenceActive(false)
  assert.equal(activeTime(), 30)
})

test('the timeline playhead follows previewed source time during a full-clip preview', () => {
  const store = useEditor.getState()
  store.setTime(30)
  store.setSequenceActive(false)
  store.setSequenceTime(0, 0, 0)
  assert.equal(selectTimelineTime(useEditor.getState()), 30)
  store.setSequenceActive(true)
  store.setSequenceTime(2.5, 6, 11.25)
  // The source clock stop advancing while the composite plays, but the
  // playhead must still move across the source timeline.
  assert.equal(useEditor.getState().time, 30)
  assert.equal(selectTimelineTime(useEditor.getState()), 11.25)
  store.setSequenceActive(false)
})
