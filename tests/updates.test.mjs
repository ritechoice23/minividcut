import assert from 'node:assert/strict'
import test from 'node:test'
import { canStartUpdate, createDownloadTracker, formatBytes, parseReleaseNotes, updateReducer } from '../src/updates.ts'

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

test('update moves from available to background download to a ready-to-install prompt', () => {
  const info = { version: '2.0.0', notes: ['New things'] }
  let state = updateReducer({ phase: 'idle' }, { type: 'checking' })
  assert.equal(state.phase, 'checking')
  state = updateReducer(state, { type: 'available', info })
  assert.deepEqual(state, { phase: 'available', info })
  state = updateReducer(state, { type: 'download', info, snapshot: { downloaded: 0, total: 100, percent: 0 } })
  assert.equal(state.phase, 'downloading')
  state = updateReducer(state, { type: 'progress', snapshot: { downloaded: 50, total: 100, percent: 50 } })
  assert.deepEqual(state, { phase: 'downloading', info, downloaded: 50, total: 100, percent: 50 })
  state = updateReducer(state, { type: 'ready' })
  assert.deepEqual(state, { phase: 'ready', info })
  state = updateReducer(state, { type: 'installing' })
  assert.deepEqual(state, { phase: 'installing', info })
  assert.deepEqual(updateReducer(state, { type: 'idle' }), { phase: 'idle' })
})

test('late download events cannot overwrite a settled update state', () => {
  const info = { version: '2.0.0', notes: [] }
  const available = updateReducer({ phase: 'idle' }, { type: 'available', info })
  assert.equal(updateReducer(available, { type: 'ready' }), available)
  const downloading = updateReducer({ phase: 'idle' }, { type: 'download', info,
    snapshot: { downloaded: 10, total: 100, percent: 10 } })
  const readyDownload = updateReducer(downloading, { type: 'ready' })
  assert.deepEqual(updateReducer(readyDownload, { type: 'progress',
    snapshot: { downloaded: 90, total: 100, percent: 90 } }), readyDownload)
  assert.equal(updateReducer(readyDownload, { type: 'ready' }), readyDownload)
  const failed = updateReducer(downloading, { type: 'error', message: 'Failed', detail: 'boom' })
  assert.deepEqual(failed, { phase: 'error', message: 'Failed', detail: 'boom', info })
})

test('a failed download or install can be retried from the error state', () => {
  assert.equal(canStartUpdate('available', 'download', 'download'), true)
  assert.equal(canStartUpdate('ready', 'download', 'install'), true)
  assert.equal(canStartUpdate('error', 'download', 'download'), true)
  assert.equal(canStartUpdate('error', 'install', 'install'), true)
  assert.equal(canStartUpdate('error', 'install', 'download'), false)
  assert.equal(canStartUpdate('error', 'download', 'install'), false)
  assert.equal(canStartUpdate('downloading', 'download', 'download'), false)
  assert.equal(canStartUpdate('installing', 'install', 'install'), false)
})

test('release notes are flattened into short lines for the prompt', () => {
  assert.deepEqual(parseReleaseNotes(undefined), [])
  assert.deepEqual(parseReleaseNotes('## What’s new\n- [Fix a bug](https://example.com)\n\n* Add a feature\n1. Third item\n4. Fourth item', 2), [
    'What’s new',
    'Fix a bug',
  ])
  assert.equal(parseReleaseNotes('x'.repeat(200))[0], `${'x'.repeat(107)}…`)
})
