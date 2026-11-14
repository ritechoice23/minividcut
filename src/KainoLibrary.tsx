import { useEffect, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'

export type KainoTrack = { id: string; title: string }
type Page = { tracks: KainoTrack[]; nextPage: number | null }
type Progress = {
  stage: 'loadingCatalog' | 'retrying' | 'checkingTrack' | 'downloading' | 'saving'
  attempt: number
  fraction?: number | null
}

export function MusicLoading({ label, fraction }: { label: string; fraction?: number | null }) {
  return <div className="music-loading">
    <small role="status">{label}{fraction == null ? '' : ` ${Math.round(fraction * 100)}%`}</small>
    <progress aria-label={label} max={1} value={fraction ?? undefined} />
  </div>
}

function progressLabel(progress: Progress | null, fallback: string) {
  switch (progress?.stage) {
    case 'retrying': return `Reconnecting to Kaino · attempt ${progress.attempt} of 3…`
    case 'checkingTrack': return 'Checking track…'
    case 'downloading': return 'Downloading track…'
    case 'saving': return 'Verifying and saving track…'
    default: return fallback
  }
}
type Props = {
  enabled: boolean
  canUse: boolean
  saved: KainoTrack[]
  onSaved: (tracks: KainoTrack[]) => void
  onUse: (track: KainoTrack) => void
  onCacheChange: (id: string, removed: boolean) => void
}

export function KainoLibrary({ enabled, canUse, saved, onSaved, onUse, onCacheChange }: Props) {
  const [query, setQuery] = useState('')
  const [requested, setRequested] = useState({ query: '', page: 1 })
  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchProgress, setSearchProgress] = useState<Progress | null>(null)
  const [searchError, setSearchError] = useState('')
  const [error, setError] = useState('')
  const [download, setDownload] = useState<{ track: KainoTrack; progress: Progress | null } | null>(null)
  const [failedDownload, setFailedDownload] = useState<{ track: KainoTrack; error: string } | null>(null)
  const [removing, setRemoving] = useState(false)
  const notify = useRef(onCacheChange)
  useEffect(() => { notify.current = onCacheChange }, [onCacheChange])

  useEffect(() => {
    if (!enabled) return
    let current = true
    setLoading(true)
    setSearchProgress(null)
    setSearchError('')
    const progress = new Channel<Progress>(update => { if (current) setSearchProgress(update) })
    void invoke<Page>('search_kaino', { ...requested, progress }).then(result => {
      if (current) setPage(result)
    }).catch(error => {
      if (current) {
        setSearchError(String(error))
      }
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [enabled, requested])

  async function downloadTrack(track: KainoTrack) {
    setError('')
    setFailedDownload(null)
    setDownload({ track, progress: null })
    const progress = new Channel<Progress>(update => {
      setDownload(current => current?.track.id === track.id ? { ...current, progress: update } : current)
    })
    try {
      const downloaded = await invoke<KainoTrack>('download_kaino', { id: track.id, progress })
      onSaved([...saved.filter(item => item.id !== downloaded.id), downloaded])
      notify.current(track.id, false)
    } catch (error) {
      setFailedDownload({ track, error: String(error) })
    } finally {
      setDownload(null)
    }
  }

  async function removeTrack(track: KainoTrack) {
    setRemoving(true)
    setError('')
    try {
      if (!await confirm(`Remove “${track.title}” from this computer? Drafts using it will need the track downloaded again.`,
        { title: 'Remove downloaded music?', okLabel: 'Remove', kind: 'warning' })) return
      await invoke('remove_kaino', { id: track.id })
      onSaved(saved.filter(item => item.id !== track.id))
      notify.current(track.id, true)
    } catch (error) {
      setError(String(error))
    } finally {
      setRemoving(false)
    }
  }

  const working = Boolean(download) || removing
  const nextPage = page?.nextPage
  return <div className="kaino-library">
    <div className="kaino-heading"><strong>Kaino music</strong><small>CC0 · No attribution required</small></div>
    {saved.length > 0 && <details>
      <summary>Downloaded ({saved.length})</summary>
      {saved.map(track => <div className="music-library-row" key={track.id}>
        <span>{track.title}</span>
        <button type="button" className="button outline small" disabled={!canUse || working}
          aria-label={`Use ${track.title}`} onClick={() => onUse(track)}>Use</button>
        <button type="button" className="text-button" disabled={working}
          aria-label={`Remove ${track.title}`} onClick={() => void removeTrack(track)}>Remove</button>
      </div>)}
    </details>}
    <form className="kaino-search" onSubmit={event => {
      event.preventDefault()
      setRequested({ query: query.trim(), page: 1 })
    }}>
      <input type="search" aria-label="Search Kaino music" placeholder="Search tracks" maxLength={100}
        value={query} onChange={event => setQuery(event.target.value)} />
      <button className="button outline small" type="submit">Search</button>
    </form>
    {loading && <MusicLoading label={progressLabel(searchProgress, 'Loading Kaino tracks…')} />}
    {searchError && <div className="music-retry">
      <small role="alert">{searchError}{page?.tracks.length ? ' Showing the last results.' : ''}</small>
      <button type="button" className="button outline small"
        onClick={() => setRequested(current => ({ ...current }))}>Retry catalog</button>
    </div>}
    {!loading && !searchError && page?.tracks.length === 0 && <small>No tracks found.</small>}
    {!loading && page?.tracks.map(track => {
          const installed = saved.some(item => item.id === track.id)
          const downloading = download?.track.id === track.id
          return <div className="music-library-row" key={track.id}>
            <span>{track.title}</span>
            <button type="button" className="button outline small" disabled={working || (installed && !canUse)}
              aria-label={installed ? `Use ${track.title} from Kaino` : `Download ${track.title}`}
              onClick={() => installed ? onUse(track) : void downloadTrack(track)}>
              {downloading ? 'Downloading…' : installed ? 'Use' : 'Download'}
            </button>
          </div>
        })}
    {download && <MusicLoading label={progressLabel(download.progress, `Opening ${download.track.title}…`)}
      fraction={download.progress?.fraction} />}
    {failedDownload && <div className="music-retry">
      <small role="alert">{failedDownload.track.title} · {failedDownload.error}</small>
      <button type="button" className="button outline small" disabled={working}
        onClick={() => void downloadTrack(failedDownload.track)}>Retry download</button>
    </div>}
    {removing && <MusicLoading label="Removing track…" />}
    {!loading && !searchError && (requested.page > 1 || Boolean(nextPage)) && <div className="kaino-pagination">
      <button type="button" className="button outline small" disabled={requested.page <= 1}
        onClick={() => setRequested(current => ({ ...current, page: current.page - 1 }))}>Previous</button>
      <button type="button" className="button outline small" disabled={!nextPage}
        onClick={() => { if (nextPage) setRequested(current => ({ ...current, page: nextPage })) }}>Next</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </div>
}
