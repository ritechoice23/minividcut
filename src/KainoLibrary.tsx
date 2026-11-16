import { useCallback, useEffect, useRef, useState } from 'react'
import { convertFileSrc, Channel, invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Check, Download, LoaderCircle, Pause, Play, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { Waveform } from './Waveform'

export type KainoTrack = { id: string; title: string }
type Page = { tracks: KainoTrack[]; nextPage: number | null }
type Progress = {
  stage: 'loadingCatalog' | 'retrying' | 'checkingTrack' | 'previewing' | 'downloading' | 'saving'
  attempt: number
  fraction?: number | null
}
type DownloadState = {
  title: string
  progress: Progress | null
  error: string
  queued?: boolean
  canceled?: boolean
}

const MAX_CONCURRENT_DOWNLOADS = 2
const CANCEL_MESSAGE = 'Download canceled.'

export function MusicLoading({ label, fraction }: { label: string; fraction?: number | null }) {
  return <div className="music-loading">
    <small role="status">{label}{fraction == null ? '' : ` ${Math.round(fraction * 100)}%`}</small>
    <progress aria-label={label} max={1} value={fraction ?? undefined} />
  </div>
}

function progressLabel(progress: Progress | null, fallback: string) {
  switch (progress?.stage) {
    case 'retrying': return `Reconnecting · attempt ${progress.attempt} of 3`
    case 'checkingTrack': return 'Checking track…'
    case 'previewing': return 'Loading preview…'
    case 'downloading': return 'Downloading…'
    case 'saving': return 'Verifying and saving…'
    default: return fallback
  }
}

type Props = {
  enabled: boolean
  canUse: boolean
  saved: KainoTrack[]
  onSaved: (update: KainoTrack[] | ((current: KainoTrack[]) => KainoTrack[])) => void
  onUse: (track: KainoTrack, start?: number) => void
  onCacheChange: (id: string, removed: boolean) => void
}

type RowProps = {
  track: KainoTrack
  installed: boolean
  download?: DownloadState
  queued: boolean
  removing: boolean
  previewing: boolean
  previewLoading: boolean
  canUse: boolean
  onPreview: () => void
  onUse: () => void
  onDownload: () => void
  onRetry: () => void
  onCancel: () => void
  onRemove: () => void
}

function TrackRow({ track, installed, download, queued, removing, previewing, previewLoading, canUse,
  onPreview, onUse, onDownload, onRetry, onCancel, onRemove }: RowProps) {
  const busy = Boolean(download && !download.error && !queued)
  const failed = Boolean(download?.error)
  const canceled = Boolean(download?.canceled)
  const meta = queued ? 'Queued…'
    : canceled ? 'Canceled'
    : failed ? 'Download failed'
    : busy ? progressLabel(download!.progress, 'Starting download…')
    : removing ? 'Removing from this device…'
    : previewing ? 'Playing preview'
    : installed ? 'In your library'
    : 'CC0 · Free to use'
  return <div className={`kaino-row${previewing ? ' previewing' : ''}${failed ? ' failed' : ''}`}
    aria-busy={busy || removing}>
    <div className="kaino-row-main">
      <span className="kaino-row-title">{track.title}</span>
      <span className="kaino-row-meta">{meta}</span>
    </div>
    <div className="kaino-row-actions">
      <button type="button" className={`icon-button compact preview${previewing ? ' active' : ''}`}
        disabled={removing} aria-label={previewing ? `Stop preview of ${track.title}` : `Preview ${track.title}`}
        aria-pressed={previewing} title={previewing ? 'Stop preview' : 'Preview before downloading'}
        onClick={onPreview}>
        {previewLoading ? <LoaderCircle size={14} className="spin" />
          : previewing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      {installed && <button type="button" className="button outline small action" disabled={!canUse || removing}
        aria-label={`Use ${track.title}`} onClick={onUse}><Check size={12} />Use</button>}
      {!installed && <button type="button" className="button outline small action" disabled={busy || queued || removing}
        aria-label={queued ? `${track.title} is queued` : failed ? `Retry downloading ${track.title}` : `Download ${track.title}`}
        onClick={queued ? onCancel : failed ? onRetry : onDownload}>
        {queued ? <><LoaderCircle size={12} className="spin" />Queued</>
          : failed ? <><RotateCcw size={12} />Retry</>
          : busy ? <><LoaderCircle size={12} className="spin" />Working</>
          : <><Download size={12} />Download</>}
      </button>}
      {(busy || queued) && <button type="button" className="icon-button compact cancel" disabled={removing}
        aria-label={`Cancel download of ${track.title}`} title="Cancel download" onClick={onCancel}>
        <X size={13} />
      </button>}
      {installed && <button type="button" className="icon-button compact remove" disabled={removing}
        aria-label={`Remove ${track.title}`} title="Remove from this device" onClick={onRemove}>
        {removing ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={13} />}
      </button>}
    </div>
    {busy && <progress className="kaino-row-progress" aria-label={`Downloading ${track.title}`}
      max={1} value={download!.progress?.fraction ?? undefined} />}
    {download?.error && <div className="kaino-row-error" role="alert">
      <small>{download.error}</small>
      <button type="button" className="text-button" onClick={onRetry}>Try again</button>
    </div>}
  </div>
}

export function KainoLibrary({ enabled, canUse, saved, onSaved, onUse, onCacheChange }: Props) {
  const [query, setQuery] = useState('')
  const [requested, setRequested] = useState({ query: '', page: 1 })
  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchProgress, setSearchProgress] = useState<Progress | null>(null)
  const [searchError, setSearchError] = useState('')
  const [error, setError] = useState('')
  // Each track owns its own download/removal state so operations stay independent.
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<{ track: KainoTrack; path: string } | null>(null)
  const [loadingPreview, setLoadingPreview] = useState('')
  const [previewProgress, setPreviewProgress] = useState<Progress | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewDuration, setPreviewDuration] = useState(0)
  const [previewTime, setPreviewTime] = useState(0)
  const [inPoints, setInPoints] = useState<Record<string, number>>({})
  const audio = useRef<HTMLAudioElement>(null)
  const previewRequest = useRef(0)
  const downloadQueue = useRef<KainoTrack[]>([])
  const activeDownloads = useRef(new Set<string>())
  const notify = useRef(onCacheChange)
  useEffect(() => { notify.current = onCacheChange }, [onCacheChange])

  const stopPreview = useCallback(() => {
    ++previewRequest.current
    const element = audio.current
    if (element) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
    setPreview(null)
    setPreviewError('')
    setPreviewDuration(0)
    setPreviewTime(0)
  }, [])

  useEffect(() => {
    if (!enabled) stopPreview()
  }, [enabled, stopPreview])
  useEffect(() => stopPreview, [stopPreview])

  useEffect(() => {
    const element = audio.current
    if (!element || !preview) return
    element.src = convertFileSrc(preview.path)
    element.currentTime = 0
    void element.play().catch(() => setPreviewError('This preview could not play here.'))
  }, [preview])

  async function previewTrack(track: KainoTrack) {
    if (preview?.track.id === track.id) {
      stopPreview()
      return
    }
    stopPreview()
    const request = ++previewRequest.current
    setLoadingPreview(track.id)
    setError('')
    const progress = new Channel<Progress>(update => {
      if (request === previewRequest.current) setPreviewProgress(update)
    })
    try {
      const path = await invoke<string>('preview_kaino', { id: track.id, progress })
      if (request === previewRequest.current) setPreview({ track, path })
    } catch (cause) {
      if (request === previewRequest.current) setPreviewError(String(cause))
    } finally {
      if (request === previewRequest.current) {
        setLoadingPreview('')
        setPreviewProgress(null)
      }
    }
  }

  function useTrack(track: KainoTrack) {
    const start = inPoints[track.id] ?? 0
    stopPreview()
    onUse(track, start > 0 ? start : undefined)
  }

  useEffect(() => {
    if (!enabled) return
    let current = true
    setLoading(true)
    setSearchProgress(null)
    setSearchError('')
    const progress = new Channel<Progress>(update => { if (current) setSearchProgress(update) })
    void invoke<Page>('search_kaino', { ...requested, progress }).then(result => {
      if (current) setPage(result)
    }).catch(cause => {
      if (current) setSearchError(String(cause))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [enabled, requested])

  function setDownload(id: string, update: Partial<DownloadState>) {
    setDownloads(current => ({
      ...current,
      [id]: { ...(current[id] ?? { title: id, progress: null, error: '' }), ...update },
    }))
  }

  function pumpQueue() {
    while (activeDownloads.current.size < MAX_CONCURRENT_DOWNLOADS && downloadQueue.current.length) {
      const next = downloadQueue.current.shift()
      if (next) void startDownload(next)
    }
  }

  async function startDownload(track: KainoTrack) {
    activeDownloads.current.add(track.id)
    setDownload(track.id, { title: track.title, progress: null, error: '', queued: false, canceled: false })
    const progress = new Channel<Progress>(update => {
      setDownloads(current => {
        const state = current[track.id]
        return state && !state.error && !state.canceled
          ? { ...current, [track.id]: { ...state, progress: update } }
          : current
      })
    })
    try {
      const downloaded = await invoke<KainoTrack>('download_kaino', { id: track.id, progress })
      onSaved(current => [...current.filter(item => item.id !== downloaded.id), downloaded]
        .sort((a, b) => a.title.localeCompare(b.title)))
      notify.current(track.id, false)
      setDownloads(current => {
        const next = { ...current }
        delete next[track.id]
        return next
      })
    } catch (cause) {
      const message = String(cause)
      setDownload(track.id, { error: message, canceled: message.includes('canceled') })
    } finally {
      activeDownloads.current.delete(track.id)
      pumpQueue()
    }
  }

  function downloadTrack(track: KainoTrack) {
    setError('')
    setDownload(track.id, { title: track.title, progress: null, error: '', queued: false, canceled: false })
    if (activeDownloads.current.size >= MAX_CONCURRENT_DOWNLOADS) {
      downloadQueue.current.push(track)
      setDownload(track.id, { queued: true })
      return
    }
    void startDownload(track)
  }

  async function cancelDownload(track: KainoTrack) {
    if (downloads[track.id]?.queued) {
      downloadQueue.current = downloadQueue.current.filter(item => item.id !== track.id)
      setDownload(track.id, { error: CANCEL_MESSAGE, canceled: true, queued: false })
      return
    }
    try {
      await invoke('cancel_kaino', { id: track.id })
    } catch (cause) {
      setError(String(cause))
    }
  }

  async function removeTrack(track: KainoTrack) {
    setRemoving(current => ({ ...current, [track.id]: true }))
    setError('')
    try {
      if (!await confirm(`Remove “${track.title}” from this computer? Drafts using it will need the track downloaded again.`,
        { title: 'Remove downloaded music?', okLabel: 'Remove', kind: 'warning' })) return
      await invoke('remove_kaino', { id: track.id })
      onSaved(current => current.filter(item => item.id !== track.id))
      notify.current(track.id, true)
      if (preview?.track.id === track.id) stopPreview()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setRemoving(current => {
        const next = { ...current }
        delete next[track.id]
        return next
      })
    }
  }

  const states = Object.values(downloads)
  const active = states.filter(state => !state.error && !state.queued)
  const queued = states.filter(state => state.queued).length
  const nextPage = page?.nextPage
  const row = (track: KainoTrack, installed: boolean) => <TrackRow key={track.id} track={track}
    installed={installed} download={downloads[track.id]} queued={Boolean(downloads[track.id]?.queued)}
    removing={Boolean(removing[track.id])}
    previewing={preview?.track.id === track.id} previewLoading={loadingPreview === track.id}
    canUse={canUse} onPreview={() => void previewTrack(track)} onUse={() => useTrack(track)}
    onDownload={() => void downloadTrack(track)} onRetry={() => void downloadTrack(track)}
    onCancel={() => void cancelDownload(track)} onRemove={() => void removeTrack(track)} />

  return <div className="kaino-library">
    <div className="kaino-heading">
      <strong>Kaino music</strong>
      <span className="kaino-badge">CC0 · no attribution</span>
    </div>
    {(active.length > 0 || queued > 0) && <div className="kaino-session" role="status">
      <LoaderCircle size={13} className="spin" />
      <span>{active.length === 1 ? `Downloading “${active[0].title}”` : `Downloading ${active.length} tracks`}{queued ? ` · ${queued} queued` : ''}</span>
      <span className="kaino-session-count">{active.length + queued}</span>
    </div>}
    <form className="kaino-search" onSubmit={event => {
      event.preventDefault()
      setRequested({ query: query.trim(), page: 1 })
    }}>
      <span className="kaino-search-icon"><Search size={13} /></span>
      <input type="search" aria-label="Search Kaino music" placeholder="Search CC0 tracks" maxLength={100}
        value={query} onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" className="icon-button compact clear" aria-label="Clear search"
        onClick={() => setQuery('')}><X size={13} /></button>}
      <button className="button outline small" type="submit">Search</button>
    </form>
    {loading && <MusicLoading label={progressLabel(searchProgress, 'Loading Kaino tracks…')} />}
    {searchError && <div className="music-retry">
      <small role="alert">{searchError}{page?.tracks.length ? ' Showing the last results.' : ''}</small>
      <button type="button" className="button outline small"
        onClick={() => setRequested(current => ({ ...current }))}>Retry catalog</button>
    </div>}
    {saved.length > 0 && <details className="kaino-saved" open>
      <summary>In your library <span className="kaino-count">{saved.length}</span></summary>
      <div className="kaino-rows">{saved.map(track => row(track, true))}</div>
    </details>}
    {page && !loading && !searchError && <div className="kaino-results">
      <div className="kaino-section-label">{requested.query ? 'Search results' : 'Popular tracks'}</div>
      {page.tracks.length === 0
        ? <p className="kaino-empty">No tracks found. Try a different search.</p>
        : <div className="kaino-rows">{page.tracks.map(track => row(track, saved.some(item => item.id === track.id)))}</div>}
    </div>}
    {loadingPreview && <MusicLoading label={progressLabel(previewProgress, 'Loading preview…')} />}
    {preview && <div className="kaino-audition">
      <small role="status">Playing preview · {preview.track.title}</small>
      <Waveform path={preview.path} duration={previewDuration} position={previewTime}
        inPoint={inPoints[preview.track.id] ?? 0}
        onInPoint={seconds => setInPoints(current => ({ ...current, [preview.track.id]: seconds }))} />
      <small className="kaino-audition-hint">Drag the strip to choose where this track starts when you use it.</small>
    </div>}
    {previewError && <div className="kaino-row-error" role="alert"><small>{previewError}</small></div>}
    {error && <small role="alert">{error}</small>}
    {!loading && !searchError && (requested.page > 1 || Boolean(nextPage)) && <div className="kaino-pagination">
      <button type="button" className="button outline small" disabled={requested.page <= 1}
        onClick={() => setRequested(current => ({ ...current, page: current.page - 1 }))}>Previous</button>
      <span className="kaino-page">Page {requested.page}</span>
      <button type="button" className="button outline small" disabled={!nextPage}
        onClick={() => { if (nextPage) setRequested(current => ({ ...current, page: nextPage })) }}>Next</button>
    </div>}
    <audio ref={audio} hidden preload="none"
      onLoadedMetadata={event => setPreviewDuration(event.currentTarget.duration)}
      onTimeUpdate={event => setPreviewTime(event.currentTarget.currentTime)}
      onEnded={() => setPreview(null)} />
  </div>
}
