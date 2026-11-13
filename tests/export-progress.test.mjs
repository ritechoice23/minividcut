import assert from 'node:assert/strict'
import test from 'node:test'
import { fileSize, summarizeExport } from '../src/export-progress.ts'

test('weights concurrent progress by clip length and reports successful bytes only', () => {
  const ranges = [{ start: 0, end: 20 }, { start: 1, end: 11 }, { start: 2, end: 12 }]
  assert.deepEqual(summarizeExport(ranges, [
    { status: 'encoding', fraction: .5 },
    { status: 'saved', bytes: 42000, encoder: 'hevc_nvenc' },
    { status: 'queued' },
  ]), { saved: 1, failed: 0, active: 1, bytes: 42000, percent: 50, total: 3, canceled: 0 })
  assert.deepEqual(summarizeExport(ranges, [
    { status: 'saved', bytes: 12000, encoder: 'libx265' },
    { status: 'saved', bytes: 42000, encoder: 'hevc_nvenc' },
    { status: 'failed', error: 'Could not save file' },
  ]), { saved: 2, failed: 1, active: 0, bytes: 54000, percent: 100, total: 3, canceled: 0 })
  assert.equal(fileSize(5_600_000), '5.6 MB')
})

test('keeps completed files and reports canceled clips separately', () => {
  const ranges = [{ start: 0, end: 5 }, { start: 5, end: 10 }]
  assert.deepEqual(summarizeExport(ranges, [
    { status: 'saved', bytes: 1000, encoder: 'libx265' },
    { status: 'canceled' },
  ]), { saved: 1, failed: 0, active: 0, bytes: 1000, percent: 50, total: 2, canceled: 1 })
})
