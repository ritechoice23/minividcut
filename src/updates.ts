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

export type UpdateInfo = {
  version: string
  notes: string[]
  date?: string
}

/** Downloading stays in the background; installing only starts on request. */
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'available'; info: UpdateInfo }
  | ({ phase: 'downloading'; info: UpdateInfo } & DownloadSnapshot)
  | { phase: 'ready'; info: UpdateInfo }
  | { phase: 'installing'; info: UpdateInfo }
  | { phase: 'error'; message: string; detail: string; info: UpdateInfo | null }

export type UpdateAction =
  | { type: 'checking' }
  | { type: 'current' }
  | { type: 'available'; info: UpdateInfo }
  | { type: 'download'; info: UpdateInfo; snapshot: DownloadSnapshot }
  | { type: 'progress'; snapshot: DownloadSnapshot }
  | { type: 'ready' }
  | { type: 'installing' }
  | { type: 'error'; message: string; detail: string }
  | { type: 'idle' }

export const PENDING_INSTALL_KEY = 'minividcut.update.pending-install'

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Remembers an update the user chose to finish on the next launch, so a
 * restart prompt never interrupts the current editing session. */
export function createPendingInstall(storage: KeyStorage) {
  return {
    defer(version: string) { storage.setItem(PENDING_INSTALL_KEY, version) },
    peek() { return storage.getItem(PENDING_INSTALL_KEY) },
    consume() {
      const version = storage.getItem(PENDING_INSTALL_KEY)
      storage.removeItem(PENDING_INSTALL_KEY)
      return version
    },
  }
}

/** Short label for the persistent top-bar update indicator. */
export function updateIndicatorLabel(status: UpdateStatus): string | null {
  switch (status.phase) {
    case 'downloading': return status.percent !== null ? `Downloading ${status.percent}%` : 'Downloading…'
    case 'ready': return 'Update ready'
    case 'installing': return 'Installing…'
    case 'error': return 'Update failed · Retry'
    default: return null
  }
}

/** An ordinary click starts from its prompt; a retry starts from the error state. */
export function canStartUpdate(phase: UpdateStatus['phase'], failedStage: 'download' | 'install', action: 'download' | 'install') {
  return action === 'download'
    ? phase === 'available' || (phase === 'error' && failedStage === 'download')
    : phase === 'ready' || (phase === 'error' && failedStage === 'install')
}

export function updateReducer(state: UpdateStatus, action: UpdateAction): UpdateStatus {
  switch (action.type) {
    case 'checking': return { phase: 'checking' }
    case 'current': return { phase: 'current' }
    case 'available': return { phase: 'available', info: action.info }
    case 'download': return { phase: 'downloading', info: action.info, ...action.snapshot }
    case 'progress': return state.phase === 'downloading' ? { ...state, ...action.snapshot } : state
    case 'ready': return state.phase === 'downloading' ? { phase: 'ready', info: state.info } : state
    case 'installing': return 'info' in state && state.info ? { phase: 'installing', info: state.info } : state
    case 'error': return { phase: 'error', message: action.message, detail: action.detail,
      info: 'info' in state ? state.info : null }
    case 'idle': return { phase: 'idle' }
  }
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

/** The releases page, for installing by hand when an in-app update cannot finish. */
export const RELEASES_URL = 'https://github.com/ritechoice23/minividcut/releases/latest'

/**
 * Turns the updater's technical error into a sentence that says what to do.
 * `detail` is whatever the updater reported, which is also shown underneath.
 */
export function describeUpdateError(detail: string, stage: 'download' | 'install'): string {
  const text = detail.toLowerCase()
  if (/signature|verif|minisign|pubkey|public key/.test(text)) {
    return 'The download didn’t pass its security check. The release files may have changed while this window was open. Try again, or restart MiniVidCut first.'
  }
  if (/timed? ?out|timeout|dns|network|connect|offline|error sending request|os error 1006|unreachable|reset by peer/.test(text)) {
    return 'Couldn’t reach GitHub. Check your connection and try again.'
  }
  if (/\b(404|403|410)\b|not found|status code/.test(text)) {
    return 'The update file isn’t available right now. It may still be uploading, so try again in a few minutes.'
  }
  if (/access is denied|permission|in use|being used|os error 5\b|os error 32|elevat/.test(text)) {
    return stage === 'install'
      ? 'Windows wouldn’t let the installer replace MiniVidCut. Close other copies of the app and try again, or install the new version by hand.'
      : 'MiniVidCut couldn’t save the download. Check free disk space and that nothing blocks your temporary folder, then try again.'
  }
  if (/no space|disk full|os error 112/.test(text)) {
    return 'There isn’t enough free disk space for the update. Free some space and try again.'
  }
  return stage === 'install'
    ? 'The update could not be installed. Try again, or install the new version by hand.'
    : 'The update could not be downloaded. Try again, or download it by hand.'
}
