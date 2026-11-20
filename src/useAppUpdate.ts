import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { check as checkTauri, type Update as TauriUpdate } from '@tauri-apps/plugin-updater'
import { createDownloadTracker, formatBytes, parseReleaseNotes, type DownloadSnapshot } from './updates'

const SNOOZE_KEY = 'minividcut.update.snoozed'

export type UpdateInfo = {
  version: string
  notes: string[]
  date?: string
}

export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'available'; info: UpdateInfo }
  | ({ phase: 'downloading'; info: UpdateInfo } & DownloadSnapshot)
  | { phase: 'installing'; info: UpdateInfo }
  | { phase: 'error'; message: string; detail: string }

export type AppUpdate = {
  status: UpdateStatus
  checkForUpdates: (manual?: boolean) => Promise<void>
  install: () => Promise<void>
  retry: () => Promise<void>
  dismiss: () => void
}

const infoFrom = (update: TauriUpdate): UpdateInfo => ({
  version: update.version,
  date: update.date,
  notes: parseReleaseNotes(update.body),
})

const detailFrom = (error: unknown) => error instanceof Error ? error.message : String(error)

export function useAppUpdate(): AppUpdate {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const updateRef = useRef<TauriUpdate | null>(null)
  const checking = useRef(false)
  const installing = useRef(false)

  const checkForUpdates = useCallback(async (manual = false) => {
    if (checking.current || installing.current) return
    checking.current = true
    setStatus({ phase: 'checking' })
    try {
      const found = await checkTauri({ timeout: 20_000 })
      if (!found) {
        setStatus({ phase: 'current' })
        return
      }
      await updateRef.current?.close().catch(() => {})
      updateRef.current = found
      const info = infoFrom(found)
      const snoozed = manual ? null : localStorage.getItem(SNOOZE_KEY)
      setStatus(snoozed === found.version ? { phase: 'idle' } : { phase: 'available', info })
    } catch (error) {
      setStatus(manual
        ? { phase: 'error', message: 'Couldn’t check for updates. Check your connection and try again.', detail: detailFrom(error) }
        : { phase: 'idle' })
    } finally {
      checking.current = false
    }
  }, [])

  const install = useCallback(async () => {
    const found = updateRef.current
    if (!found || installing.current || checking.current) return
    installing.current = true
    const info = infoFrom(found)
    const tracker = createDownloadTracker()
    setStatus({ phase: 'downloading', info, ...tracker.snapshot() })
    try {
      // On Windows the installer exits the app and, with restartAfterInstall,
      // relaunches the newly installed version when it finishes.
      await found.downloadAndInstall(event => {
        setStatus(previous => previous.phase === 'downloading'
          ? { ...previous, ...tracker.apply(event) }
          : previous)
      }, { restartAfterInstall: true })
      setStatus({ phase: 'installing', info })
    } catch (error) {
      setStatus({ phase: 'error', message: 'The update could not be installed. Please try again.', detail: detailFrom(error) })
      installing.current = false
    }
  }, [])

  const retry = useCallback(async () => {
    // A failed install leaves the downloaded update available, so resume it
    // instead of forcing another metadata check.
    if (updateRef.current) await install()
    else await checkForUpdates(true)
  }, [install, checkForUpdates])

  const dismiss = useCallback(() => {
    const found = updateRef.current
    if (found) {
      localStorage.setItem(SNOOZE_KEY, found.version)
      void found.close().catch(() => {})
      updateRef.current = null
    }
    setStatus({ phase: 'idle' })
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setTimeout(() => { void checkForUpdates() }, 4000)
    return () => window.clearTimeout(timer)
  }, [checkForUpdates])

  return { status, checkForUpdates, install, retry, dismiss }
}

/** Human-readable line for the download progress shown in the prompt. */
export function progressLabel(status: Extract<UpdateStatus, { phase: 'downloading' }>): string {
  const size = status.total ? `${formatBytes(status.downloaded)} / ${formatBytes(status.total)}` : formatBytes(status.downloaded)
  return status.percent !== null
    ? `Downloading update · ${status.percent}%${size ? ` · ${size}` : ''}`
    : 'Downloading update…'
}
