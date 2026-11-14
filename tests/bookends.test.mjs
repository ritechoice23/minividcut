import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveBookends } from '../src/bookends.ts'

const intro = { path: 'C:/intro.mp4', name: 'intro.mp4', transition: 'fade' }
const outro = { path: 'C:/outro.mp4', name: 'outro.mp4', transition: 'cut' }

test('intro and outro inherit independently and null turns off just one end', () => {
  assert.deepEqual(effectiveBookends({ intro, outro }), { intro, outro })
  assert.deepEqual(effectiveBookends({ intro, outro }, { intro: null }), { intro: null, outro })
  assert.deepEqual(effectiveBookends({}, { intro }), { intro, outro: undefined })
})
