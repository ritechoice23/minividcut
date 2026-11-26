import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PREFERENCES, exportFileName, fileNameExample, parsePreferences, PREFERENCES_KEY, readPreferences, writePreferences } from '../src/preferences.ts'

test('missing or malformed preferences fall back to defaults', () => {
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES)
  assert.deepEqual(parsePreferences('not json'), DEFAULT_PREFERENCES)
  assert.deepEqual(parsePreferences('[1, 2]'), DEFAULT_PREFERENCES)
})

test('new projects default to vertical shorts with compact quality', () => {
  assert.equal(DEFAULT_PREFERENCES.defaultFormat, 'portrait')
  assert.equal(DEFAULT_PREFERENCES.defaultQuality, 'compact')
  assert.deepEqual(DEFAULT_PREFERENCES.fileNameParts, { video: false, number: false, title: true })
})

test('valid saved values are kept and invalid ones are replaced individually', () => {
  const parsed = parsePreferences(JSON.stringify({
    defaultFormat: 'landscape', defaultQuality: 'ultra', fileNames: 'numbered',
    openFolderAfterExport: true, autoCaption: 'yes', backgroundUpdates: false,
  }))
  assert.equal(parsed.defaultFormat, 'landscape')
  assert.equal(parsed.defaultQuality, DEFAULT_PREFERENCES.defaultQuality)
  assert.deepEqual(parsed.fileNameParts, { video: true, number: true, title: false })
  assert.equal(parsed.openFolderAfterExport, true)
  assert.equal(parsed.autoCaption, DEFAULT_PREFERENCES.autoCaption)
  assert.equal(parsed.backgroundUpdates, false)
  assert.equal(parsed.snapDefault, DEFAULT_PREFERENCES.snapDefault)
})

test('preferences round-trip through storage and survive unavailable storage', () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const next = { ...DEFAULT_PREFERENCES, defaultQuality: 'lossless', autoCaption: true }
  assert.equal(writePreferences(storage, next), true)
  assert.ok(values.has(PREFERENCES_KEY))
  assert.deepEqual(readPreferences(storage), next)
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.deepEqual(readPreferences(broken), DEFAULT_PREFERENCES)
  assert.equal(writePreferences(broken, next), false)
})

test('file names combine the chosen parts in a fixed order', () => {
  const clip = { title: ' Moon facts ', number: 3, video: 'Moon Tour' }
  assert.equal(exportFileName({ video: false, number: false, title: true }, clip), 'Moon facts')
  assert.equal(exportFileName({ video: true, number: true, title: false }, clip), 'Moon Tour - 03')
  assert.equal(exportFileName({ video: true, number: true, title: true }, clip), 'Moon Tour - 03 - Moon facts')
  assert.equal(exportFileName({ video: false, number: false, title: true }, { ...clip, title: undefined }), undefined)
  assert.equal(fileNameExample({ video: false, number: true, title: true }), '01 - Lava plains')
})

test('saved file name parts need at least one part', () => {
  const none = parsePreferences(JSON.stringify({ fileNameParts: { video: false, number: false, title: false } }))
  assert.deepEqual(none.fileNameParts, DEFAULT_PREFERENCES.fileNameParts)
})
