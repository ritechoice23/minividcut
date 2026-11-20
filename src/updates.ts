// Pure helpers shared by the in-app updater UI. Kept free of Tauri imports so
// they can be exercised by the Node test suite.

export type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

export type DownloadSnapshot = {
  downloaded: number
  total: number | null
  percent: number | null
}

/** Accumulates plugin download events into a progress snapshot. */
export function createDownloadTracker() {
  let downloaded = 0
  let total: number | null = null

  const snapshot = (): DownloadSnapshot => ({
    downloaded,
    total,
    percent: total !== null && total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : null,
  })

  return {
    snapshot,
    apply(event: UpdateDownloadEvent): DownloadSnapshot {
      if (event.event === 'Started') {
        const length = event.data.contentLength
        total = typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null
      } else if (event.event === 'Progress' && Number.isFinite(event.data.chunkLength)) {
        downloaded += Math.max(0, event.data.chunkLength)
      }
      return snapshot()
    },
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Turns a GitHub release body into a few short lines for the update prompt. */
export function parseReleaseNotes(body?: string, limit = 3): string[] {
  if (!body) return []
  return body
    .split(/\r?\n/)
    .map(line => line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
    .map(line => line.replace(/^\s*(?:[-*]|\d+\.|#{1,6})\s*/, '').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map(line => line.length > 110 ? `${line.slice(0, 107)}…` : line)
}
