import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clipSegments, cutRange, cutSegments, deleteFromRanges, exportUnits, keptDuration, moveBoundary,
  normalizeClip, parseTime, resizeClipEdge, segmentAt, splitClipAt, splitRange, stamp, trimClips,
  validRange, withSegments,
} from '../src/clip.ts'

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

test('ripple delete removes a range from the whole video and closes the gap', () => {
  const whole = [{ start: 0, end: 60 }]
  assert.deepEqual(deleteFromRanges(whole, { start: 10, end: 20 }), [
    { start: 0, end: 10 },
    { start: 20, end: 60 },
  ])
  assert.equal(keptDuration(deleteFromRanges(whole, { start: 10, end: 20 })), 50)
  assert.deepEqual(deleteFromRanges(whole, { start: 0, end: 5 }), [{ start: 5, end: 60 }])
  assert.deepEqual(deleteFromRanges(whole, { start: 55, end: 60 }), [{ start: 0, end: 55 }])
  assert.deepEqual(deleteFromRanges(whole, { start: 0, end: 60 }), [])
  assert.deepEqual(deleteFromRanges(whole, { start: 20, end: 10 }), whole)
  assert.deepEqual(deleteFromRanges(whole, { start: 30, end: 40 }), [
    { start: 0, end: 30 },
    { start: 40, end: 60 },
  ])
  assert.deepEqual(
    deleteFromRanges([{ start: 0, end: 10 }, { start: 20, end: 30 }], { start: 8, end: 22 }),
    [{ start: 0, end: 8 }, { start: 22, end: 30 }],
  )
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

test('trims the In-Out range from every saved clip without splitting them', () => {
  const first = { id: 1, start: 0, end: 10, title: 'Intro' }
  const untouched = { id: 2, start: 12, end: 20 }
  const swallowed = { id: 3, start: 4.5, end: 5.5, title: 'Detail' }
  const sliced = []
  const track = { cues: [] }
  const result = trimClips([first, untouched, swallowed], { start: 4, end: 6 }, 24,
    (_track, part) => { sliced.push(part); return track })

  assert.equal(result.length, 2, 'the removed clip disappears and the cut clip stays one object')
  assert.deepEqual(result[0], {
    id: 1, start: 0, end: 10,
    segments: [{ start: 0, end: 4 }, { start: 6, end: 10 }],
    title: 'Intro', captions: track,
  })
  assert.equal(result[1], untouched, 'clips outside the cut keep their identity')
  assert.deepEqual(sliced, [{ start: 0, end: 10 }], 'captions are sliced once to the shared bounds')
})

test('leaves clips unchanged when the cut misses them all', () => {
  const clips = [{ id: 1, start: 0, end: 4 }, { id: 2, start: 6, end: 9 }]
  assert.deepEqual(trimClips(clips, { start: 10, end: 12 }, 12), clips)
})

test('segment helpers keep bounds in sync', () => {
  const clip = { id: 1, start: 0, end: 10 }
  assert.deepEqual(clipSegments(clip), [{ start: 0, end: 10 }], 'draft clips without segments read as one range')
  const next = withSegments(clip, [{ start: 6, end: 10 }, { start: 0, end: 4 }], 12)
  assert.deepEqual(next.segments, [{ start: 0, end: 4 }, { start: 6, end: 10 }])
  assert.deepEqual({ start: next.start, end: next.end }, { start: 0, end: 10 })
  assert.deepEqual(cutSegments(next, { start: 3, end: 7 }, 12), [{ start: 0, end: 3 }, { start: 7, end: 10 }])
  assert.equal(withSegments(clip, [{ start: 0, end: 0.01 }], 12), null)
})

test('a clip can be cut at the playhead, resized at its edges, and located by time', () => {
  const clip = { id: 1, start: 0, end: 10, segments: [{ start: 0, end: 4 }, { start: 6, end: 10 }] }
  assert.deepEqual(segmentAt(clip, 5), null, 'the removed middle is not part of the clip')
  assert.deepEqual(segmentAt(clip, 7), { start: 6, end: 10 })

  const split = splitClipAt(clip, 8, 12)
  assert.deepEqual(split.segments, [{ start: 0, end: 4 }, { start: 6, end: 8 }, { start: 8, end: 10 }])
  assert.equal(split.id, 1, 'splitting adds a boundary inside the same clip')
  assert.equal(splitClipAt(clip, 5, 12), null, 'splitting inside a removed section is a no-op')

  const grown = resizeClipEdge(clip, 'start', 0, 12)
  assert.deepEqual(grown.segments, clip.segments)
  const trimmedStart = resizeClipEdge(clip, 'start', 1, 12)
  assert.deepEqual(trimmedStart.segments, [{ start: 1, end: 4 }, { start: 6, end: 10 }])
  const trimmedEnd = resizeClipEdge(clip, 'end', 9, 12)
  assert.deepEqual(trimmedEnd.segments, [{ start: 0, end: 4 }, { start: 6, end: 9 }])
  assert.equal(resizeClipEdge(clip, 'start', 4, 12), null, 'an edge cannot cross its own segment')
})

test('export units flatten segments while keeping their parent clip', () => {
  const clips = [
    { id: 1, start: 0, end: 10, segments: [{ start: 0, end: 4 }, { start: 6, end: 10 }] },
    { id: 2, start: 12, end: 20 },
  ]
  const units = exportUnits(clips)
  assert.deepEqual(units.map(unit => [unit.clip.id, unit.segment, unit.first, unit.last]), [
    [1, { start: 0, end: 4 }, true, false],
    [1, { start: 6, end: 10 }, false, true],
    [2, { start: 12, end: 20 }, true, true],
  ])
})

test('draft migration normalizes clips written before segments existed', () => {
  assert.deepEqual(normalizeClip({ id: 1, start: 2, end: 6 }, 10), { id: 1, start: 2, end: 6 })
  assert.deepEqual(normalizeClip({ id: 1, start: 2, end: 6, segments: [{ start: 2, end: 4 }, { start: 5, end: 6 }] }, 10).segments,
    [{ start: 2, end: 4 }, { start: 5, end: 6 }])
  assert.equal(normalizeClip({ id: 1, start: 2, end: 11 }, 10), null)
})
