import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveMusic, musicPosition } from '../src/music.ts'

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
