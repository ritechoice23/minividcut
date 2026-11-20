import assert from 'node:assert/strict'
import test from 'node:test'
import { createDownloadTracker, formatBytes, parseReleaseNotes } from '../src/updates.ts'

test('download tracker accumulates chunks and reports a bounded percentage', () => {
  const tracker = createDownloadTracker()
  assert.deepEqual(tracker.apply({ event: 'Started', data: { contentLength: 200 } }), {
    downloaded: 0, total: 200, percent: 0,
  })
  assert.equal(tracker.apply({ event: 'Progress', data: { chunkLength: 50 } }).percent, 25)
  assert.equal(tracker.apply({ event: 'Progress', data: { chunkLength: 180 } }).percent, 100)
  assert.equal(tracker.apply({ event: 'Finished' }).percent, 100)
})

test('download tracker handles a missing content length and ignores bad chunks', () => {
  const tracker = createDownloadTracker()
  assert.equal(tracker.apply({ event: 'Started', data: {} }).percent, null)
  assert.equal(tracker.apply({ event: 'Progress', data: { chunkLength: -5 } }).downloaded, 0)
  assert.equal(tracker.apply({ event: 'Progress', data: { chunkLength: 64 } }).total, null)
})

test('formatBytes only describes positive finite sizes', () => {
  assert.equal(formatBytes(0), '')
  assert.equal(formatBytes(Number.NaN), '')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})

test('release notes are flattened into short lines for the prompt', () => {
  assert.deepEqual(parseReleaseNotes(undefined), [])
  assert.deepEqual(parseReleaseNotes('## What’s new\n- [Fix a bug](https://example.com)\n\n* Add a feature\n1. Third item\n4. Fourth item', 2), [
    'What’s new',
    'Fix a bug',
  ])
  assert.equal(parseReleaseNotes('x'.repeat(200))[0], `${'x'.repeat(107)}…`)
})
