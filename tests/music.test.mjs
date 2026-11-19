import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveMusic, mixStorageKey, musicGain, musicPosition, musicTrackKey } from '../src/music.ts'

const project = { track: { kind: 'library', id: 'winter-dust' }, volume: 20 }
const custom = { track: { kind: 'file', path: 'C:/Music/track.mp3', name: 'track.mp3' }, volume: 35 }

test('old clips and new clips without an override follow the current project music', () => {
  assert.equal(effectiveMusic(project), project)
  assert.equal(effectiveMusic(null), null)
  assert.equal(effectiveMusic(custom), custom)
})

test('an explicit clip track or disabled override takes precedence', () => {
  assert.equal(effectiveMusic(project, custom), custom)
  assert.equal(effectiveMusic(project, null), null)
  assert.equal(effectiveMusic(null, custom), custom)
})

test('each clip starts music from zero and seeks within the current loop', () => {
  assert.equal(musicPosition(40, 40, 3), 0)
  assert.equal(musicPosition(47.5, 40, 3), 1.5)
  assert.equal(musicPosition(46, 40, 3), 0)
  assert.equal(musicPosition(39, 40, 3), 0)
  assert.equal(musicPosition(47, 40, NaN), 0)
})

test('a chosen in-point offsets every loop without going negative', () => {
  assert.equal(musicPosition(40, 40, 10, 4), 4)
  assert.equal(musicPosition(46, 40, 10, 4), 10 % 10)
  assert.equal(musicPosition(46, 40, 10, 12), 8)
  assert.equal(musicPosition(39, 40, 10, 4), 4)
  assert.equal(musicPosition(40, 40, 10, -5), 0)
})

test('fade ramps the clip edges but stays off by default', () => {
  assert.equal(musicGain(40.5, 40, 44), 1)
  assert.equal(musicGain(39, 40, 44, true), 0)
  assert.ok(Math.abs(musicGain(40.4, 40, 44, true) - 0.5) < 1e-6)
  assert.equal(musicGain(42, 40, 44, true), 1)
  assert.ok(Math.abs(musicGain(43.6, 40, 44, true) - 0.5) < 1e-6)
  assert.equal(musicGain(45, 40, 44, true), 0)
  assert.equal(musicGain(41, 40, 41, true), 0)
})

test('musicTrackKey depends only on the track, not mix settings', () => {
  const base = { track: { kind: 'kaino', id: 'abc', name: 'Song', collection: 'music' }, volume: 15 }
  const varied = { ...base, volume: 77, start: 12.5, fade: true }
  assert.equal(musicTrackKey(base.track), musicTrackKey(varied.track))
  assert.equal(musicTrackKey(custom.track), musicTrackKey({ ...custom.track, name: 'renamed.mp3' }))
})

test('musicTrackKey is distinct across file, kaino and library tracks', () => {
  const file = { kind: 'file', path: 'C:/Music/track.mp3', name: 'track.mp3' }
  const kaino = { kind: 'kaino', id: 'track.mp3', name: 'track.mp3' }
  const library = { kind: 'library', id: 'track.mp3' }
  const keys = new Set([musicTrackKey(file), musicTrackKey(kaino), musicTrackKey(library)])
  assert.equal(keys.size, 3)
  assert.equal(musicTrackKey(file), 'file:C:/Music/track.mp3')
  assert.equal(musicTrackKey(kaino), 'kaino:track.mp3')
  assert.equal(musicTrackKey({ kind: 'kaino', id: 'track.mp3', name: 'x', collection: 'sfx' }), 'kaino:sfx:track.mp3')
  assert.equal(musicTrackKey(library), 'library:track.mp3')
})

test('mixStorageKey namespaces the track key', () => {
  assert.equal(mixStorageKey(custom.track), 'minividcut:music-mix:' + musicTrackKey(custom.track))
  assert.equal(mixStorageKey(project.track), 'minividcut:music-mix:library:winter-dust')
})

test('musicGain fade stays in [0,1], is monotonic on fade-in and hits endpoints', () => {
  const start = 40
  const end = 44
  assert.equal(musicGain(start, start, end, true), 0)
  assert.equal(musicGain(start + 1, start, end, true), 1)
  assert.equal(musicGain(end - 1, start, end, true), 1)
  assert.equal(musicGain(end, start, end, true), 0)
  assert.equal(musicGain(start - 5, start, end, true), 0)
  assert.equal(musicGain(end + 5, start, end, true), 0)
  let previous = -1
  for (let i = 0; i <= 200; i++) {
    const time = start + i / 100 // 0 .. 2s, covering the whole fade-in
    const gain = musicGain(time, start, end, true)
    assert.ok(gain >= 0 && gain <= 1, `gain out of range at ${time}: ${gain}`)
    assert.ok(gain >= previous, `gain decreased at ${time}: ${gain} < ${previous}`)
    previous = gain
  }
  // Linear ramps match ffmpeg's afade curve used by the export.
  assert.ok(Math.abs(musicGain(40.4, start, end, true) - 0.5) < 1e-6)
  assert.ok(Math.abs(musicGain(40.2, start, end, true) - 0.25) < 1e-6)
  assert.ok(Math.abs(musicGain(43.8, start, end, true) - 0.25) < 1e-6)
})
