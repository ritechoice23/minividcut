import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSequenceMap, clipSpans, reorderClips, sequenceAtSource, sourceAtSequence } from '../src/sequence-timeline.ts'

const clips = [
  { id: 1, start: 0, end: 10, segments: [{ start: 0, end: 4 }, { start: 6, end: 10 }] },
  { id: 2, start: 20, end: 25 },
]

test('the sequence closes up across internal cuts and between clips', () => {
  const map = buildSequenceMap(clips)
  assert.equal(map.duration, 13)
  assert.deepEqual(map.pieces.map(piece => [piece.clipId, piece.start, piece.end]), [
    [1, 0, 4], [1, 4, 8], [2, 8, 13],
  ])
})

test('sequence and source times map back and forth', () => {
  const map = buildSequenceMap(clips)
  assert.deepEqual(sourceAtSequence(map, 5), { clipId: 1, time: 7 })
  assert.deepEqual(sourceAtSequence(map, 4), { clipId: 1, time: 6 })
  assert.deepEqual(sourceAtSequence(map, 10), { clipId: 2, time: 22 })
  assert.deepEqual(sourceAtSequence(map, 13), { clipId: 2, time: 25 })
  assert.equal(sourceAtSequence(map, 99), null, 'times past the sequence have no source')
  assert.equal(sequenceAtSource(map, 5), null, 'a removed source range has no sequence position')
  assert.equal(sequenceAtSource(map, 7), 5)
  assert.equal(sequenceAtSource(map, 22), 10)
})

test('clips can be reordered and their spans follow', () => {
  const reordered = reorderClips(clips, 1, 0)
  assert.deepEqual(reordered.map(clip => clip.id), [2, 1])
  assert.deepEqual(clipSpans(buildSequenceMap(reordered), reordered), [
    { index: 0, start: 0, end: 5 }, { index: 1, start: 5, end: 13 },
  ])
  assert.deepEqual(reorderClips(clips, 0, 0), clips)
  assert.deepEqual(reorderClips(clips, 0, 99), clips)
})
