import { useEffect, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { ExternalLink, Pause, Play, X } from 'lucide-react'
import { DEFAULT_MUSIC_VOLUME, effectiveMusic, MUSIC_LIBRARY } from './music'
import type { Music, MusicTrack } from './music'
import { fileSize } from './export-progress'
import { KainoLibrary } from './KainoLibrary'
import type { KainoTrack } from './KainoLibrary'

type Props = {
  project: Music | null
  clip: { music?: Music | null; title: string } | null
  disabled: boolean
  canPreview: boolean
  playing: boolean
  open: boolean
  onClose: () => void
  onPreview: () => void
  onChange: (scope: 'project' | 'clip', music: Music | null | undefined, path?: string) => void
  onKainoCacheChange: (id: string, removed: boolean) => void
}

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']
type TrackStatus = { id: string; installed: boolean; bytes: number }

export function MusicMenu({ project, clip, disabled, canPreview, playing, open: visible, onClose, onPreview, onChange, onKainoCacheChange }: Props) {
  const [scope, setScope] = useState<'project' | 'clip'>('clip')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [otherTracksOpen, setOtherTracksOpen] = useState(false)
  const [kainoTracks, setKainoTracks] = useState<KainoTrack[]>([])
  const [library, setLibrary] = useState<TrackStatus[]>([])
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [download, setDownload] = useState<{ id: string; fraction: number } | null>(null)
  const target = clip ? scope : 'project'
  const current = target === 'project' ? project : clip?.music
  const active = effectiveMusic(project, clip?.music)
  const canAudition = active && (target === 'clip' || active === project)
  const value = current === undefined ? 'inherit' : current === null ? 'off'
    : current.track.kind === 'kaino' ? `kaino:${current.track.id}` : current.track.kind === 'library' ? current.track.id : 'file'

  useEffect(() => {
    if (!visible) return
    let current = true
    void invoke<KainoTrack[]>('local_kaino_tracks').then(tracks => {
      if (current) setKainoTracks(tracks)
    }).catch(error => { if (current) setError(String(error)) })
    return () => { current = false }
  }, [visible])

  async function toggleOtherTracks(open: boolean) {
    setOtherTracksOpen(open)
    if (!open || loadingLibrary) return
    setLoadingLibrary(true)
    setError('')
    try {
      setLibrary(await invoke<TrackStatus[]>('music_library'))
    } catch (error) {
      setError(String(error))
    } finally {
      setLoadingLibrary(false)
    }
  }

  async function downloadTrack(id: string) {
    setError('')
    setDownload({ id, fraction: 0 })
    const progress = new Channel<number>(fraction => {
      setDownload(current => current?.id === id ? { id, fraction } : current)
    })
    try {
      await invoke('download_music', { id, progress })
      setLibrary(items => items.map(track => track.id === id ? { ...track, installed: true } : track))
    } catch (error) {
      setError(String(error))
    } finally {
      setDownload(null)
    }
  }

  async function select(value: string | KainoTrack) {
    setError('')
    if (value === 'inherit' || value === 'off') {
      onChange(target, value === 'inherit' ? undefined : null)
      return
    }
    setPending(true)
    try {
      let track: MusicTrack
      if (typeof value !== 'string') {
        track = { kind: 'kaino', id: value.id, name: value.title }
      } else if (value.startsWith('kaino:')) {
        const downloaded = kainoTracks.find(track => `kaino:${track.id}` === value)
        if (!downloaded) return
        track = { kind: 'kaino', id: downloaded.id, name: downloaded.title }
      } else if (value === 'browse') {
        const path = await open({ title: 'Choose background music', filters: [{ name: 'Audio files', extensions: AUDIO_EXTENSIONS }] })
        if (!path) return
        track = { kind: 'file', path, name: path.split(/[/\\]/).pop() ?? path }
      } else {
        const library = MUSIC_LIBRARY.find(track => track.id === value)
        if (!library) return
        track = { kind: 'library', id: library.id }
      }
      const path = await invoke<string>('open_music', { track })
      onChange(target, { track, volume: current?.volume ?? DEFAULT_MUSIC_VOLUME }, path)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  return <section id="music-menu" className="moment-panel editor-media-panel panel" hidden={!visible}
      aria-labelledby="music-title" onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
      }}>
      <header className="caption-style-heading">
        <h2 id="music-title">Background music</h2>
        <button type="button" className="icon-button compact" aria-label="Close background music" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="editor-media-fields">
      {clip && <label>Apply to
        <select aria-label="Apply to" value={target} disabled={pending} onChange={event => {
          setScope(event.target.value === 'clip' ? 'clip' : 'project')
          setError('')
        }}>
          <option value="project">All clips</option>
          <option value="clip">{clip.title}</option>
        </select>
      </label>}
      <label>Track
        <select aria-label="Track" value={value} disabled={pending || disabled} onChange={event => void select(event.target.value)}>
          {target === 'clip' && <option value="inherit">Use project music</option>}
          <option value="off">No music</option>
          {current?.track.kind === 'file' && <option value="file" disabled>{current.track.name}</option>}
          <option value="browse">Choose an audio file…</option>
          {current?.track.kind === 'kaino' && !kainoTracks.some(track => `kaino:${track.id}` === value) &&
            <option value={value} disabled>{current.track.name} (download required)</option>}
          {kainoTracks.map(track => <option key={track.id} value={`kaino:${track.id}`}>{track.title}</option>)}
          {MUSIC_LIBRARY.filter(track => track.id === value || library.some(item => item.id === track.id && item.installed))
            .map(track => <option key={track.id} value={track.id}>{track.name}</option>)}
        </select>
      </label>
      {current && <label>
        <span className="music-level">Music volume <output>{current.volume}%</output></span>
        <input aria-label="Music volume" type="range" min={0} max={100} value={current.volume} disabled={pending || disabled}
          onChange={event => onChange(target, { ...current, volume: event.target.valueAsNumber })} />
      </label>}
      {canAudition && <button type="button" className="button outline small" disabled={!canPreview || pending || disabled}
        onClick={onPreview}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? 'Pause preview' : 'Preview mix'}</button>}
      <button type="button" className="text-button media-library-trigger" aria-expanded={libraryOpen}
        aria-controls="music-library" onClick={() => setLibraryOpen(!libraryOpen)}>Music library</button>
      <div id="music-library" className="music-library" hidden={!libraryOpen}>
        <KainoLibrary enabled={visible && libraryOpen} canUse={!pending && !disabled} saved={kainoTracks}
          onSaved={setKainoTracks} onUse={track => void select(track)} onCacheChange={onKainoCacheChange} />
        <button type="button" className="text-button media-library-trigger" aria-expanded={otherTracksOpen}
          aria-controls="original-music" onClick={() => void toggleOtherTracks(!otherTracksOpen)}>Original loop pack</button>
        <div id="original-music" className="music-library" hidden={!otherTracksOpen}>
        <small>CC0 · No attribution required</small>
        {loadingLibrary && <small role="status">Checking downloads…</small>}
        {library.map(item => {
          const track = MUSIC_LIBRARY.find(track => track.id === item.id)
          if (!track) return null
          const downloading = download?.id === item.id
          return <div className="music-library-row" key={item.id}>
            <span>{track.name}<small>{item.installed ? 'Downloaded' : fileSize(item.bytes)}</small></span>
            <button type="button" className="button outline small" disabled={(item.installed && disabled) || pending || Boolean(download)}
              aria-label={item.installed ? `Use ${track.name}` : `Download ${track.name}`}
              onClick={() => void (item.installed ? select(item.id) : downloadTrack(item.id))}>
              {downloading ? `${Math.round(download.fraction * 100)}%` : item.installed ? 'Use' : 'Download'}
            </button>
          </div>
        })}
        {download && <small role="status">Downloading {MUSIC_LIBRARY.find(track => track.id === download.id)?.name}…</small>}
        </div>
        <button type="button" className="text-button media-library-trigger" onClick={() => {
          void invoke('browse_mixkit').catch(error => setError(String(error)))
        }}><ExternalLink size={13} /> Browse Mixkit</button>
        <small>Download on Mixkit, then choose the audio file here.</small>
      </div>
      {pending && <small role="status">Opening track…</small>}
      {error && <small role="alert">{error}</small>}
      </div>
    </section>
}
