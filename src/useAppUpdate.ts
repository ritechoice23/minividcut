import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { check as checkTauri, type Update as TauriUpdate } from '@tauri-apps/plugin-updater'
import { canStartUpdate, createDownloadTracker, createPendingInstall, formatBytes, parseReleaseNotes, updateReducer,
  type UpdateInfo, type UpdateStatus } from './updates'

const SNOOZE_KEY = 'minividcut.update.snoozed'

export type { UpdateInfo, UpdateStatus }
export type AppUpdate = {
  status: UpdateStatus
  checkForUpdates: (manual?: boolean) => Promise<void>
  download: (background?: boolean) => Promise<void>
  install: () => Promise<void>
  retry: () => Promise<void>
  dismiss: () => void
  deferInstall: () => void
  progressHidden: boolean
  showProgress: () => void
  hideProgress: () => void
  /** The downloaded update installs when the app is closed. */
  installsOnClose: boolean
}

const infoFrom = (update: TauriUpdate): UpdateInfo => ({
  version: update.version,
  date: update.date,
  notes: parseReleaseNotes(update.body),
})

const detailFrom = (error: unknown) => error instanceof Error ? error.message : String(error)

export function useAppUpdate(): AppUpdate {
  const [status, dispatch] = useReducer(updateReducer, { phase: 'idle' } as UpdateStatus)
  const [progressHidden, setProgressHidden] = useState(false)
  const statusRef = useRef(status)
  statusRef.current = status
  const updateRef = useRef<TauriUpdate | null>(null)
  const pending = useRef(createPendingInstall(localStorage))
  const busy = useRef(false)
  const failedStage = useRef<'download' | 'install'>('download')

  const checkForUpdates = useCallback(async (manual = false) => {
    if (busy.current) return
    busy.current = true
    dispatch({ type: 'checking' })
    try {
      const found = await checkTauri({ timeout: 20_000 })
      await updateRef.current?.close().catch(() => {})
      updateRef.current = found
      if (!found) {
        dispatch({ type: 'current' })
        return
      }
      const info = infoFrom(found)
      const snoozed = manual ? null : localStorage.getItem(SNOOZE_KEY)
      dispatch(snoozed === found.version ? { type: 'idle' } : { type: 'available', info })
    } catch (error) {
      updateRef.current = null
      dispatch(manual
        ? { type: 'error', message: 'Couldn’t check for updates. Check your connection and try again.', detail: detailFrom(error) }
        : { type: 'idle' })
    } finally {
      busy.current = false
    }
  }, [])

  const download = useCallback(async (background = true) => {
    const found = updateRef.current
    if (!found || busy.current || !canStartUpdate(statusRef.current.phase, failedStage.current, 'download')) return
    busy.current = true
    failedStage.current = 'download'
    setProgressHidden(background)
    const info = infoFrom(found)
    const tracker = createDownloadTracker()
    dispatch({ type: 'download', info, snapshot: tracker.snapshot() })
    try {
      // Download only. The editor stays usable, and installing waits for the
      // user to confirm the restart prompt shown when the download finishes.
      await found.download(event => dispatch({ type: 'progress', snapshot: tracker.apply(event) }))
      dispatch({ type: 'ready' })
    } catch (error) {
      dispatch({ type: 'error', message: 'The update could not be downloaded. Please try again.', detail: detailFrom(error) })
    } finally {
      busy.current = false
    }
  }, [])

  const install = useCallback(async () => {
    const found = updateRef.current
    if (!found || busy.current || !canStartUpdate(statusRef.current.phase, failedStage.current, 'install')) return
    busy.current = true
    failedStage.current = 'install'
    dispatch({ type: 'installing' })
    try {
      // On Windows this exits the app and launches the installer; the installer
      // relaunches MiniVidCut on the new version when it finishes.
      await found.install({ restartAfterInstall: true })
    } catch (error) {
      dispatch({ type: 'error', message: 'The update could not be installed. Please try again.', detail: detailFrom(error) })
    } finally {
      busy.current = false
    }
  }, [])

  const retry = useCallback(async () => {
    if (!updateRef.current) await checkForUpdates(true)
    else if (failedStage.current === 'install') await install()
    else await download()
  }, [checkForUpdates, install, download])

  const dismiss = useCallback(() => {
    const found = updateRef.current
    if (found) {
      localStorage.setItem(SNOOZE_KEY, found.version)
      void found.close().catch(() => {})
      updateRef.current = null
    }
    dispatch({ type: 'idle' })
  }, [])

  // Never interrupt work: a downloaded update waits and installs quietly when
  // the user closes MiniVidCut. "Restart now" is only there for those who want it.
  const [closeArmed, setCloseArmed] = useState(false)
  const deferInstall = useCallback(() => setCloseArmed(true), [])
  const installsOnClose = status.phase === 'ready'
  useEffect(() => {
    if (!isTauri() || status.phase !== 'ready') return
    let stop: (() => void) | undefined
    let disposed = false
    void getCurrentWindow().onCloseRequested(async event => {
      const found = updateRef.current
      if (!found || busy.current) return
      event.preventDefault()
      busy.current = true
      // Let the editor save its recovery draft before the installer takes over.
      window.dispatchEvent(new Event('pagehide'))
      try {
        // Windows: launches the passive installer and exits the app.
        await found.install({ restartAfterInstall: false })
      } catch {
        busy.current = false
        await getCurrentWindow().destroy()
      }
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten })
    return () => { disposed = true; stop?.() }
  }, [status.phase])

  useEffect(() => {
    if (!isTauri()) return
    // Older versions installed a deferred update at launch, which blocked the
    // editor. Forget that flag; the normal background check picks the update up.
    pending.current.consume()
    const timer = window.setTimeout(() => { void checkForUpdates() }, 4000)
    return () => window.clearTimeout(timer)
  }, [checkForUpdates])

  const showProgress = useCallback(() => setProgressHidden(false), [])
  const hideProgress = useCallback(() => setProgressHidden(true), [])

  return { status, checkForUpdates, download, install, retry, dismiss, deferInstall,
    progressHidden: progressHidden || (status.phase === 'ready' && closeArmed), showProgress, hideProgress, installsOnClose }
}

/** Human-readable line for the download progress shown beside the editor. */
export function progressLabel(status: Extract<UpdateStatus, { phase: 'downloading' }>): string {
  const size = status.total ? `${formatBytes(status.downloaded)} / ${formatBytes(status.total)}` : formatBytes(status.downloaded)
  return status.percent !== null
    ? `Downloading update · ${status.percent}%${size ? ` · ${size}` : ''}`
    : 'Downloading update…'
}
