import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveMusic, musicGain, musicPosition } from '../src/music.ts'

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
