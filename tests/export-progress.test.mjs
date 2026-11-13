import assert from 'node:assert/strict'
import test from 'node:test'
import { fileSize, summarizeExport } from '../src/export-progress.ts'

test('weights concurrent progress by clip length and reports successful bytes only', () => {
  const ranges = [{ start: 0, end: 20 }, { start: 1, end: 11 }, { start: 2, end: 12 }]
  assert.deepEqual(summarizeExport(ranges, [
    { status: 'encoding', fraction: .5 },
    { status: 'saved', bytes: 42000 },
    { status: 'queued' },
  ]), { saved: 1, failed: 0, active: 1, bytes: 42000, percent: 50, total: 3 })
  assert.deepEqual(summarizeExport(ranges, [
    { status: 'saved', bytes: 12000 },
    { status: 'saved', bytes: 42000 },
    { status: 'failed', error: 'Could not save file' },
  ]), { saved: 2, failed: 1, active: 0, bytes: 54000, percent: 100, total: 3 })
  assert.equal(fileSize(5_600_000), '5.6 MB')
})
