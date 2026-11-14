import { useEffect, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'

export type KainoTrack = { id: string; title: string }
type Page = { tracks: KainoTrack[]; nextPage: number | null }
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
  const [searchError, setSearchError] = useState('')
  const [error, setError] = useState('')
  const [download, setDownload] = useState<{ id: string; fraction?: number } | null>(null)
  const [removing, setRemoving] = useState(false)
  const notify = useRef(onCacheChange)
  useEffect(() => { notify.current = onCacheChange }, [onCacheChange])

  useEffect(() => {
    if (!enabled) return
    let current = true
    setLoading(true)
    setSearchError('')
    void invoke<Page>('search_kaino', requested).then(result => {
      if (current) setPage(result)
    }).catch(error => {
      if (current) {
        setPage(null)
        setSearchError(String(error))
      }
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [enabled, requested])

  async function downloadTrack(track: KainoTrack) {
    setError('')
    setDownload({ id: track.id })
    const progress = new Channel<number>(fraction => {
      setDownload(current => current?.id === track.id ? { ...current, fraction } : current)
    })
    try {
      const downloaded = await invoke<KainoTrack>('download_kaino', { id: track.id, progress })
      onSaved([...saved.filter(item => item.id !== downloaded.id), downloaded])
      notify.current(track.id, false)
    } catch (error) {
      setError(String(error))
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
    {loading ? <small role="status">Loading Kaino tracks…</small> : searchError
      ? <small role="alert">{searchError}</small> : page?.tracks.length === 0
        ? <small>No tracks found.</small> : page?.tracks.map(track => {
          const installed = saved.some(item => item.id === track.id)
          const downloading = download?.id === track.id
          return <div className="music-library-row" key={track.id}>
            <span>{track.title}</span>
            <button type="button" className="button outline small" disabled={working || (installed && !canUse)}
              aria-label={installed ? `Use ${track.title} from Kaino` : `Download ${track.title}`}
              onClick={() => installed ? onUse(track) : void downloadTrack(track)}>
              {downloading ? download.fraction === undefined ? 'Downloading…' : `${Math.round(download.fraction * 100)}%`
                : installed ? 'Use' : 'Download'}
            </button>
          </div>
        })}
    {!loading && !searchError && (requested.page > 1 || Boolean(nextPage)) && <div className="kaino-pagination">
      <button type="button" className="button outline small" disabled={requested.page <= 1}
        onClick={() => setRequested(current => ({ ...current, page: current.page - 1 }))}>Previous</button>
      <button type="button" className="button outline small" disabled={!nextPage}
        onClick={() => { if (nextPage) setRequested(current => ({ ...current, page: nextPage })) }}>Next</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </div>
}
