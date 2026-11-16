import assert from 'node:assert/strict'
import test from 'node:test'
import { captionAt, captionCut, captionDisplayText, captionSlice, captionStates, captionsForKept, clipsNeedingCaptions, fitCaptionTiming, offsetCaption, restyleCaptionedClip, timedWords } from '../src/captions.ts'

const track = {
  style: { preset: 'classic', position: 'bottom', size: 'medium' },
  cues: [{ start: 3, end: 5, text: 'Hello' }, { start: 5, end: 8, text: 'there' }],
}

test('captions follow the edited timeline after a ripple delete', () => {
  const source = { ...track, cues: [
    { start: 1, end: 2, text: 'before', words: [{ start: 1, end: 2, text: 'before' }] },
    { start: 3, end: 4, text: 'deleted' },
    { start: 6, end: 7, text: 'after', words: [{ start: 6, end: 7, text: 'after' }] },
  ] }
  const kept = [{ start: 0, end: 2 }, { start: 5, end: 8 }]
  assert.deepEqual(
    captionsForKept(source, kept).cues.map(cue => ({ start: cue.start, end: cue.end, text: cue.text })),
    [{ start: 1, end: 2, text: 'before' }, { start: 3, end: 4, text: 'after' }],
  )
  assert.deepEqual(captionsForKept(source, kept).cues[1].words, [{ start: 3, end: 4, text: 'after' }])
})

test('batch generation skips clips with edited captions and fills empty tracks', () => {
  const saved = { id: 1, start: 0, end: 3, captions: track }
  const blank = { id: 2, start: 3, end: 5, captions: { ...track, cues: [{ start: 3, end: 4, text: '  ' }] } }
  const missing = { id: 3, start: 5, end: 6 }
  assert.deepEqual(clipsNeedingCaptions([saved, blank, missing]), [blank, missing])
})

test('a cut removes overlapping cues and keeps the spoken remnants', () => {
  const withWords = { ...track, cues: [{ ...track.cues[0], words: [
    { start: 3, end: 4, text: 'Hel' }, { start: 4.1, end: 5, text: 'lo' },
  ] }] }
  assert.deepEqual(captionCut(withWords, { start: 4, end: 4.5 }).cues, [
    { start: 3, end: 4, text: 'Hello', words: [{ start: 3, end: 4, text: 'Hel' }] },
    { start: 4.5, end: 5, text: 'Hello', words: [{ start: 4.5, end: 5, text: 'lo' }] },
  ])
  assert.deepEqual(captionCut(track, { start: 3, end: 8 }).cues, [])
  assert.deepEqual(captionCut(track, { start: 9, end: 10 }).cues, track.cues)
})

test('word sync delays the highlight without extending it across silence', () => {
  const cue = { start: 0, end: 2, text: 'One two', words: [
    { start: 0.2, end: 0.5, text: 'One' }, { start: 1, end: 1.4, text: 'two' },
  ] }
  const states = captionStates(cue, 'highlight', 60)
  assert.equal(captionAt(states, 0.23).active, -1)
  assert.equal(captionAt(states, 0.27).active, 0)
  assert.equal(captionAt(states, 0.8).active, -1)
  assert.equal(captionAt(states, 1.07).active, 1)
  assert.equal(captionAt(captionStates(cue, 'word', 60), 0.8), undefined)
})

test('case changes only the rendered text and sentence case follows sentences across cues', () => {
  const cues = [{ start: 0, end: 1, text: '“hÉLLO and' }, { start: 1, end: 2, text: 'wELCOME!” next LINE.' }]
  assert.deepEqual(captionDisplayText(cues, 'sentence'), ['“Héllo and', 'welcome!” Next line.'])
  assert.deepEqual(captionDisplayText(cues, 'title'), ['“Héllo And', 'Welcome!” Next Line.'])
  assert.deepEqual(captionDisplayText(cues, 'upper'), ['“HÉLLO AND', 'WELCOME!” NEXT LINE.'])
  assert.deepEqual(captionDisplayText(cues, 'lower'), ['“héllo and', 'welcome!” next line.'])
  assert.deepEqual(captionDisplayText(cues, 'original'), cues.map(cue => cue.text))
  assert.equal(cues[0].text, '“hÉLLO and')
})

test('batch styling preserves the transcript and leaves uncaptioned clips intact', () => {
  const styled = { ...track.style, case: 'upper', mode: 'highlight' }
  const clip = { id: 1, title: 'Opening', start: 3, end: 8, captions: track }
  const blank = { id: 2, start: 8, end: 10 }
  const next = restyleCaptionedClip(clip, styled)
  assert.equal(next.captions.cues, track.cues)
  assert.deepEqual(next, { ...clip, captions: { ...track, style: styled } })
  assert.equal(restyleCaptionedClip(blank, styled), blank)
})

test('preview selects the next caption at a shared boundary', () => {
  assert.equal(captionAt(track.cues, 2.99), undefined)
  assert.equal(captionAt(track.cues, 5).text, 'there')
  assert.equal(captionAt(track.cues, 8), undefined)
})

test('export and split clamp captions to the shot and can rebase them to zero', () => {
  assert.deepEqual(captionSlice(track, { start: 4, end: 7 }, true).cues, [
    { start: 0, end: 1, text: 'Hello' }, { start: 1, end: 3, text: 'there' },
  ])
  assert.deepEqual(captionSlice(track, { start: 5, end: 8 }).cues, [track.cues[1]])
  assert.equal(captionSlice(track, { start: 8, end: 9 }).cues.length, 0)
})

test('timing edits stay within the shot and do not overlap their neighbors', () => {
  const shot = { start: 2, end: 10 }
  assert.equal(fitCaptionTiming(track.cues, 0, 'end', 5.1, shot), null)
  assert.equal(fitCaptionTiming(track.cues, 0, 'start', 1, shot), null)
  assert.equal(fitCaptionTiming(track.cues, 0, 'start', 5, shot), null)
  assert.deepEqual(fitCaptionTiming(track.cues, 1, 'end', 9, shot), { ...track.cues[1], end: 9 })
})
test('speech timing survives source offsets, trims, and clip-relative export', () => {
  const cue = { start: 0, end: 2, text: 'Hello there', words: [
    { start: 0, end: 0.4, text: 'Hello' }, { start: 0.7, end: 1.5, text: 'there' },
  ] }
  const cut = captionSlice({ ...track, cues: [offsetCaption(cue, 4)] }, { start: 4.5, end: 5.8 }, true).cues[0]
  assert.equal(cut.words[0].start, cut.words[0].end)
  assert.ok(Math.abs(cut.words[1].start - 0.2) < 0.00001)
  assert.equal(cut.words[1].end, 1)
})

test('same-count edits keep spoken timing and manual captions have a timing fallback', () => {
  const cue = { start: 0, end: 2, text: 'New words', words: [
    { start: 0.1, end: 0.6, text: 'Old' }, { start: 1.2, end: 1.8, text: 'words' },
  ] }
  assert.deepEqual(timedWords(cue).map(word => [word.text, word.start]), [['New', 0.1], ['words', 1.2]])
  assert.deepEqual(timedWords({ start: 0, end: 2, text: 'One two' }).map(word => word.start), [0, 1])
  assert.deepEqual(timedWords({ ...cue, text: 'Brand new words' }).map(word => [word.text, word.start]),
    [['Brand', 0.1], ['new', 0.35], ['words', 1.2]])
})

test('highlight keeps a phrase visible through gaps, word mode only shows the spoken word', () => {
  const cue = { start: 0, end: 2, text: 'One two', words: [
    { start: 0.1, end: 0.6, text: 'One' }, { start: 1.2, end: 1.8, text: 'two' },
  ] }
  assert.deepEqual(captionStates(cue, 'highlight').map(state => [state.start, state.end, state.active]), [
    [0, 0.1, -1], [0.1, 0.6, 0], [0.6, 1.2, -1], [1.2, 1.8, 1], [1.8, 2, -1],
  ])
  assert.deepEqual(captionStates(cue, 'word').map(state => state.active), [0, 1])
})
