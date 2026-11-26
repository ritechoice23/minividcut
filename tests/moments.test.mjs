import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_MOMENT_QUERY, missingTranscriptRanges, MOMENT_PRESETS, momentCandidates, momentLimit, momentRequest, momentWorthy } from '../src/moments.ts'

test('uses the stricter maximum from the prompt or the duration field', () => {
  assert.equal(momentLimit('Funny moments, no more than 30 seconds', 60), 30)
  assert.equal(momentLimit('Under 1 minute, at most 20s', 45), 20)
  assert.equal(momentLimit('Under 1 minute', 30), 30)
  assert.equal(momentLimit('Find the key takeaway', 30), 30)
})

test('fills the requested length when speech stops before the maximum', () => {
  const cues = [
    { start: 10, end: 13, text: 'A thought' },
    { start: 14, end: 17, text: 'with an ending' },
    { start: 60, end: 63, text: 'A later thought' },
  ]
  assert.deepEqual(momentCandidates(cues, { start: 0, end: 90 }, 30).map(({ start, end, text }) => ({ start, end, text })), [
    { start: 10, end: 40, text: 'A thought with an ending' },
    { start: 60, end: 90, text: 'A later thought' },
  ])
})

test('keeps candidates inside the limit and stops short only for the next cue', () => {
  const cues = [
    { start: 0, end: 5, text: 'First thought' },
    { start: 28, end: 32, text: 'A longer next thought' },
  ]
  assert.deepEqual(momentCandidates(cues, { start: 0, end: 60 }, 30).map(({ start, end }) => ({ start, end })), [
    { start: 0, end: 28 },
    { start: 28, end: 58 },
  ])
})

test('only groups spoken cues within the duration limit and breaks at long pauses', () => {
  const cues = [
    { start: 89, end: 91, text: 'A full thought' },
    { start: 91, end: 94, text: 'with a conclusion' },
    { start: 95, end: 98, text: 'Another thought' },
    { start: 101, end: 102, text: 'After a pause' },
  ]
  assert.deepEqual(momentCandidates(cues, { start: 89, end: 102 }, 5).map(({ start, end, text }) => ({ start, end, text })), [
    { start: 89, end: 94, text: 'A full thought with a conclusion' },
    { start: 95, end: 100, text: 'Another thought' },
    { start: 101, end: 102, text: 'After a pause' },
  ])
})

test('skips a single cue longer than the limit', () => {
  assert.deepEqual(momentCandidates([{ start: 0, end: 40, text: 'Too long' }], { start: 0, end: 60 }, 30), [])
})

test('reuses cached and captioned ranges and skips short gaps between captions', () => {
  assert.deepEqual(missingTranscriptRanges({ start: 0, end: 90 }, [
    { start: 28, end: 50 }, { start: 0, end: 10 }, { start: 10.5, end: 30 }, { start: 60, end: 80 },
  ]), [{ start: 50, end: 60 }, { start: 80, end: 90 }])
})

test('reduces typed requests to the topic the model should match', () => {
  assert.equal(momentRequest('Find me 5 clips of funny moments, no more than 30 seconds'), 'funny moments')
  assert.equal(momentRequest('show some highlights about business advice'), 'business advice')
  assert.equal(momentRequest('motivational moments'), 'motivational moments')
  assert.equal(momentRequest('  under 20s '), DEFAULT_MOMENT_QUERY)
})

test('skips boilerplate and fragments before asking the model', () => {
  assert.equal(momentWorthy('Make sure you subscribe and hit the bell for more videos'), false)
  assert.equal(momentWorthy('Thanks guys'), false)
  assert.equal(momentWorthy('Nobody is coming to save you, so do the work today.'), true)
})

test('ends a cut-off candidate on its last complete sentence', () => {
  const cues = [
    { start: 0, end: 6, text: 'Consistency beats intensity.' },
    { start: 6, end: 12, text: 'Show up every day.' },
    { start: 12, end: 18, text: 'And when you miss a day' },
    { start: 18, end: 24, text: 'just start again tomorrow.' },
  ]
  const moments = momentCandidates(cues, { start: 0, end: 30 }, 15)
  assert.equal(moments[0].text, 'Consistency beats intensity. Show up every day.')
  assert.equal(moments[1].text, 'And when you miss a day just start again tomorrow.')
})

test('every quick search has a short, distinct request', () => {
  const requests = new Set(MOMENT_PRESETS.map(preset => preset.request))
  assert.equal(requests.size, MOMENT_PRESETS.length)
  for (const preset of MOMENT_PRESETS) assert.ok(preset.request.split(' ').length <= 12, preset.label)
})
