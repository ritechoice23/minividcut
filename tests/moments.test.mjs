import assert from 'node:assert/strict'
import test from 'node:test'
import { missingTranscriptRanges, momentCandidates, momentLimit } from '../src/moments.ts'

test('uses the stricter maximum from the prompt or the duration field', () => {
  assert.equal(momentLimit('Funny moments, no more than 30 seconds', 60), 30)
  assert.equal(momentLimit('Under 1 minute, at most 20s', 45), 20)
  assert.equal(momentLimit('Under 1 minute', 30), 30)
  assert.equal(momentLimit('Find the key takeaway', 30), 30)
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
    { start: 95, end: 98, text: 'Another thought' },
    { start: 101, end: 102, text: 'After a pause' },
  ])
})

test('reuses cached and captioned ranges and skips short gaps between captions', () => {
  assert.deepEqual(missingTranscriptRanges({ start: 0, end: 90 }, [
    { start: 28, end: 50 }, { start: 0, end: 10 }, { start: 10.5, end: 30 }, { start: 60, end: 80 },
  ]), [{ start: 50, end: 60 }, { start: 80, end: 90 }])
})
