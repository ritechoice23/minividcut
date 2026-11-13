import type { Range } from './clip'

export type ExportState =
  | { status: 'queued' }
  | { status: 'canceled' }
  | { status: 'encoding'; fraction: number }
  | { status: 'saved'; bytes: number; encoder: string }
  | { status: 'failed'; error: string }

export type ExportProgress = Exclude<ExportState, { status: 'queued' }> & { index: number }

export function summarizeExport(ranges: readonly Range[], states: readonly ExportState[]) {
  let saved = 0
  let failed = 0
  let canceled = 0
  let active = 0
  let bytes = 0
  let duration = 0
  let processed = 0
  states.forEach((state, index) => {
    const length = ranges[index].end - ranges[index].start
    duration += length
    switch (state.status) {
      case 'encoding':
        active++
        processed += length * state.fraction
        break
      case 'saved':
        saved++
        bytes += state.bytes
        processed += length
        break
      case 'canceled':
        canceled++
        break
      case 'failed':
        failed++
        processed += length
        break
    }
  })
  const finished = saved + failed === states.length
  const percent = finished ? 100 : Math.min(99, Math.floor(100 * processed / duration))
  return { saved, failed, active, bytes, percent, total: states.length, canceled }
}

export function fileSize(bytes: number) {
  if (bytes < 1000) return bytes + ' B'
  if (bytes < 1_000_000) return (bytes / 1000).toFixed(1) + ' KB'
  if (bytes < 1_000_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB'
  return (bytes / 1_000_000_000).toFixed(2) + ' GB'
}
