import { memo, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Pause, Play, X } from 'lucide-react'
import { DEFAULT_MUSIC_VOLUME, effectiveMusic, MUSIC_LIBRARY } from './music'
import type { Music, MusicTrack } from './music'
import { KainoLibrary, MusicLoading } from './KainoLibrary'
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

export const MusicMenu = memo(function MusicMenu({ project, clip, disabled, canPreview, playing, open: visible, onClose, onPreview, onChange, onKainoCacheChange }: Props) {
  const [scope, setScope] = useState<'project' | 'clip'>('clip')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [kainoTracks, setKainoTracks] = useState<KainoTrack[]>([])
  const [checkingSaved, setCheckingSaved] = useState(false)
  const [savedError, setSavedError] = useState('')
  const [savedRetry, setSavedRetry] = useState(0)
  const [failedTrack, setFailedTrack] = useState<KainoTrack | null>(null)
  const target = clip ? scope : 'project'
  const current = target === 'project' ? project : clip?.music
  const active = effectiveMusic(project, clip?.music)
  const canAudition = active && (target === 'clip' || active === project)
  const value = current === undefined ? 'inherit' : current === null ? 'off'
    : current.track.kind === 'kaino' ? `kaino:${current.track.id}` : current.track.kind === 'library' ? current.track.id : 'file'

  useEffect(() => {
    if (!visible) return
    let current = true
    setCheckingSaved(true)
    setSavedError('')
    void invoke<KainoTrack[]>('local_kaino_tracks').then(tracks => {
      if (current) setKainoTracks(tracks)
    }).catch(error => {
      if (current) setSavedError(String(error))
    }).finally(() => {
      if (current) setCheckingSaved(false)
    })
    return () => { current = false }
  }, [visible, savedRetry])

  async function select(value: string | KainoTrack) {
    setError('')
    setFailedTrack(null)
    if (value === 'inherit' || value === 'off') {
      onChange(target, value === 'inherit' ? undefined : null)
      return
    }
    setPending(true)
    let chosen: KainoTrack | null = null
    try {
      let track: MusicTrack
      if (typeof value !== 'string') {
        chosen = value
        track = { kind: 'kaino', id: value.id, name: value.title }
      } else if (value.startsWith('kaino:')) {
        const downloaded = kainoTracks.find(track => `kaino:${track.id}` === value)
        if (!downloaded) return
        chosen = downloaded
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
      setFailedTrack(chosen)
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
          {MUSIC_LIBRARY.filter(track => track.id === value)
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
      </div>
      {checkingSaved && <MusicLoading label="Checking downloaded tracks…" />}
      {savedError && <div className="music-retry">
        <small role="alert">{savedError}</small>
        <button type="button" className="button outline small"
          onClick={() => setSavedRetry(retry => retry + 1)}>Retry saved tracks</button>
      </div>}
      {pending && <MusicLoading label="Opening track…" />}
      {failedTrack && <button type="button" className="button outline small" disabled={pending || disabled}
        onClick={() => void select(failedTrack)}>Retry opening track</button>}
      {error && <small role="alert">{error}</small>}
      </div>
    </section>
})
