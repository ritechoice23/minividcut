import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCompositionPlan, layerState, outroLayerState, overlapFrames } from '../src/sequence-plan.ts'

const base = {
  path: 'source.mp4',
  range: { start: 10, end: 12 },
  format: 'landscape', framing: 'fill', position: { x: 50, y: 50 },
  music: null, musicPath: '', muted: false,
  media: {
    'intro.mp4': { image: false, duration: 2 },
    'outro.png': { image: true, duration: 1 },
  },
}

test('cut bookends concatenate without overlap', () => {
  const plan = buildCompositionPlan({ ...base, bookends: {
    intro: { path: 'intro.mp4', name: 'intro', transition: 'cut' },
    outro: { path: 'outro.png', name: 'outro', transition: 'cut', duration: 1 },
  } })
  assert.equal(plan.total, 5)
  assert.equal(plan.main.start, 2)
  assert.equal(plan.outro.start, 4)
  assert.equal(plan.intro.overlap, 0)
  assert.equal(plan.outro.overlap, 0)
})

test('fades use the same 15-frame cap and joined-length math as ffmpeg', () => {
  const plan = buildCompositionPlan({ ...base, bookends: {
    intro: { path: 'intro.mp4', name: 'intro', transition: 'fade' },
    outro: { path: 'outro.png', name: 'outro', transition: 'fade', duration: 1 },
  } })
  assert.equal(overlapFrames('fade', 60, 60), 15)
  assert.equal(plan.intro.overlap, 0.5)
  // 60 + 60 - 15 = 105 frames for the joined intro+main, so the outro
  // overlap is capped by its own 30 frames, not by the joined length.
  assert.equal(plan.outro.overlap, 0.5)
  assert.equal(Math.round(plan.total * 30), 60 + 60 - 15 + 30 - 15)
  assert.equal(plan.main.start, 1.5)
  assert.equal(plan.outro.start, 3)
})

test('a long transition is capped at half the shorter segment', () => {
  const plan = buildCompositionPlan({ ...base, range: { start: 0, end: 0.2 },
    bookends: { intro: { path: 'intro.mp4', name: 'intro', transition: 'slide' } } })
  assert.equal(plan.intro.overlap, 0.1) // min(15, 30, 3) frames
})

test('layer states expose crossfade alpha, slide travel and source-local time', () => {
  const plan = buildCompositionPlan({ ...base, bookends: {
    intro: { path: 'intro.mp4', name: 'intro', transition: 'fade' },
    outro: { path: 'outro.png', name: 'outro', transition: 'slide', duration: 1 },
  } })
  assert.equal(layerState(plan.intro, plan, 1).alpha, 1)
  assert.equal(layerState(plan.intro, plan, 1.75).alpha, 0.5)
  assert.equal(layerState(plan.intro, plan, 2).active, false)
  const main = layerState('main', plan, 1.75)
  assert.equal(main.active, true)
  assert.ok(Math.abs(main.local - 10.25) < 0.00001)
  assert.equal(main.alpha, 0.5)
  assert.equal(outroLayerState(plan, 3.25).alpha, 0.5)
  assert.equal(outroLayerState(plan, 3.25).slide, 50)
  assert.equal(outroLayerState(plan, 3).slide, 100)
})
