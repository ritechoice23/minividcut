import { memo, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Music2, Pause, Play, Trash2, Upload, X } from 'lucide-react'
import { Waveform } from './Waveform'
import { PercentInput } from './PercentInput'
import { DEFAULT_MUSIC_VOLUME, effectiveMusic } from './music'
import type { KainoCollection, Music, MusicTrack } from './music'
import { KainoLibrary, MusicLoading } from './KainoLibrary'
import type { KainoTrack } from './KainoLibrary'

export type ImportedTrack = { id: string; name: string; path: string; imported_at: number }

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
  onMixChange: (scope: 'project' | 'clip', music: Music | null | undefined) => void
  onKainoCacheChange: (id: string, removed: boolean, collection?: KainoCollection) => void
  imports: ImportedTrack[]
  musicPath: string
  dropActive?: boolean
  onImport: (path: string, scope: 'project' | 'clip') => Promise<void>
  onRemoveImport: (id: string) => void
}

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']

export const MusicMenu = memo(function MusicMenu({ project, clip, disabled, canPreview, playing, open: visible,
  onClose, onPreview, onChange, onMixChange, onKainoCacheChange, imports, musicPath, dropActive, onImport, onRemoveImport }: Props) {
  const [scope, setScope] = useState<'project' | 'clip'>('clip')
  const [panelTab, setPanelTab] = useState<'own' | 'library'>('own')
  const [pending, setPending] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [libraryCollection, setLibraryCollection] = useState<KainoCollection>('music')
  const [kainoTracks, setKainoTracks] = useState<KainoTrack[]>([])
  const [sfxTracks, setSfxTracks] = useState<KainoTrack[]>([])
  const [checkingSaved, setCheckingSaved] = useState(false)
  const [savedError, setSavedError] = useState('')
  const [savedRetry, setSavedRetry] = useState(0)
  const [failedTrack, setFailedTrack] = useState<KainoTrack | null>(null)
  const target = clip ? scope : 'project'
  const current = target === 'project' ? project : clip?.music
  const active = effectiveMusic(project, clip?.music)
  const canAudition = active && (target === 'clip' || active === project)

  useEffect(() => {
    if (!visible) return
    let current = true
    setCheckingSaved(true)
    setSavedError('')
    void Promise.all([
      invoke<KainoTrack[]>('local_kaino_tracks', { collection: 'music' }),
      invoke<KainoTrack[]>('local_kaino_tracks', { collection: 'sfx' }),
    ]).then(([music, sfx]) => {
      if (current) {
        setKainoTracks(music)
        setSfxTracks(sfx)
      }
    }).catch(error => {
      if (current) setSavedError(String(error))
    }).finally(() => {
      if (current) setCheckingSaved(false)
    })
    return () => { current = false }
  }, [visible, savedRetry])

  const display = current === undefined ? active : current
  const track = display?.track
  const trackName = track ? track.kind === 'library' ? track.id : track.name : ''
  const isImported = track?.kind === 'file' && imports.some(item => item.path === track.path)
  const source = !track ? '' : current === undefined ? 'inherited'
    : track.kind === 'file' ? (isImported ? 'own' : 'file') : 'library'
  const sourceLabel = source === 'inherited' ? 'From all clips'
    : source === 'own' ? 'Your music' : source === 'file' ? 'Local file' : 'Music library'

  async function applyTrack(chosen: MusicTrack, start?: number, failed?: KainoTrack | null) {
    setError('')
    setFailedTrack(failed ?? null)
    setPending(true)
    try {
      const path = await invoke<string>('open_music', { track: chosen })
      onChange(target, {
        track: chosen,
        volume: current?.volume ?? DEFAULT_MUSIC_VOLUME,
        fade: current?.fade,
        start: start && start > 0 ? start : undefined,
      }, path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  async function select(value: string | KainoTrack, start?: number, collection: KainoCollection = 'music') {
    if (value === 'inherit' || value === 'off') {
      setError('')
      onChange(target, value === 'inherit' ? undefined : null)
      return
    }
    if (typeof value !== 'string') {
      await applyTrack({ kind: 'kaino', id: value.id, name: value.title, collection }, start, value)
      return
    }
    if (value.startsWith('kaino-sfx:')) {
      const downloaded = sfxTracks.find(track => `kaino-sfx:${track.id}` === value)
      if (downloaded) await applyTrack({ kind: 'kaino', id: downloaded.id, name: downloaded.title, collection: 'sfx' }, start, downloaded)
      return
    }
    if (value.startsWith('kaino:')) {
      const downloaded = kainoTracks.find(track => `kaino:${track.id}` === value)
      if (downloaded) await applyTrack({ kind: 'kaino', id: downloaded.id, name: downloaded.title, collection }, start, downloaded)
      return
    }
    setError('Choose a track from your music or the music library.')
  }

  async function importFile(path?: string) {
    setError('')
    let chosen = path
    if (!chosen) {
      const picked = await open({ title: 'Import background music', filters: [{ name: 'Audio files', extensions: AUDIO_EXTENSIONS }] })
      if (typeof picked !== 'string') return
      chosen = picked
    }
    setImporting(true)
    try {
      await onImport(chosen, target)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setImporting(false)
    }
  }

  const busy = pending || importing || disabled

  return <section id="music-menu" className="moment-panel editor-media-panel panel" hidden={!visible}
      aria-labelledby="music-title" onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
      }}>
      <header className="caption-style-heading">
        <h2 id="music-title">Music</h2>
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
      <div className="music-track-card">
        <div className="music-track-card-head">
          <span className="music-track-name">{trackName || 'No background music'}</span>
          {track && <span className="music-source-badge" data-source={source}>{sourceLabel}</span>}
        </div>
        {track && musicPath && <Waveform className="kaino-waveform compact" readOnly
          path={musicPath} duration={0} position={0} inPoint={0} onInPoint={() => {}} />}
        <div className="music-track-actions">
          {target === 'clip' && current === undefined && track && <>
            <button type="button" className="text-button" disabled={busy}
              onClick={() => setPanelTab('own')}>Override for this clip</button>
            <button type="button" className="text-button" disabled={busy}
              onClick={() => void select('off')}>Remove music</button>
          </>}
          {target === 'clip' && current !== undefined && <button type="button" className="text-button"
            disabled={busy} onClick={() => void select('inherit')}>Use project music</button>}
          {track && current !== undefined && <button type="button" className="text-button" disabled={busy}
            onClick={() => setPanelTab('own')}>Change track</button>}
          {track && current !== undefined && <button type="button" className="text-button" disabled={busy}
            onClick={() => void select('off')}>Remove music</button>}
          {!track && <button type="button" className="button outline small music-import-primary" disabled={busy}
            onClick={() => void importFile()}><Upload size={13} /> Import audio file</button>}
        </div>
        {current && <label>Music volume
          <PercentInput label="Music volume" min={0} max={100} value={Math.round(current.volume)} disabled={busy}
            onCommit={value => onMixChange(target, { ...current, volume: value })} />
        </label>}
        {current && <div className="music-tuning">
          <label>Start at (seconds)
            <input type="number" aria-label="Music start offset in seconds" min={0} max={3600} step={0.1}
              value={current.start ?? 0} disabled={busy}
              onChange={event => {
                const value = event.target.valueAsNumber
                onMixChange(target, { ...current, start: Number.isFinite(value) && value > 0 ? value : undefined })
              }} />
          </label>
          <label className="music-fade">
            <input type="checkbox" aria-label="Fade music in and out" checked={current.fade ?? false}
              disabled={busy}
              onChange={event => onMixChange(target, { ...current, fade: event.target.checked })} />
            Soft fade
          </label>
        </div>}
        {canAudition && <button type="button" className="button outline small" disabled={!canPreview || busy}
          onClick={onPreview}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? 'Pause preview' : 'Preview mix'}</button>}
      </div>
      <div className="music-tabs" role="tablist" aria-label="Music source">
        <button type="button" role="tab" aria-selected={panelTab === 'own'} className="music-tab"
          onClick={() => setPanelTab('own')}>Your music</button>
        <button type="button" role="tab" aria-selected={panelTab === 'library'} className="music-tab"
          onClick={() => setPanelTab('library')}>Music library</button>
      </div>
      {panelTab === 'own' ? <div className="music-own" role="tabpanel">
        <div className={`music-import-zone${dropActive ? ' dragover' : ''}`}>
          <Music2 size={16} />
          <span>Use your own sound</span>
          <button type="button" className="button outline small music-import-primary" disabled={busy}
            onClick={() => void importFile()}><Upload size={13} /> Import audio file</button>
          <small>MP3, WAV, M4A, AAC, FLAC, OGG or OPUS. You can also drop a file on this panel.</small>
        </div>
        {imports.length > 0 && <div className="kaino-results">
          <div className="kaino-section-label">Imported files</div>
          <div className="kaino-rows">{imports.map(item => {
            const selected = track?.kind === 'file' && track.path === item.path
            return <div className={`kaino-row${selected ? ' previewing' : ''}`} key={item.id}>
              <div className="kaino-row-main">
                <span className="kaino-row-title">{item.name}</span>
                <span className="kaino-row-meta">{selected ? 'In use' : 'Imported · on this device'}</span>
              </div>
              <div className="kaino-row-actions">
                <button type="button" className="button outline small action" disabled={busy}
                  aria-label={`Use ${item.name}`}
                  onClick={() => void applyTrack({ kind: 'file', path: item.path, name: item.name })}>Use</button>
                <button type="button" className="icon-button compact remove" aria-label={`Remove ${item.name}`}
                  title="Remove from this device" onClick={() => onRemoveImport(item.id)}><Trash2 size={13} /></button>
              </div>
            </div>
          })}</div>
        </div>}
        {kainoTracks.length + sfxTracks.length > 0 && <div className="kaino-results">
          <div className="kaino-section-label">Downloaded tracks</div>
          <div className="kaino-rows">
            {kainoTracks.map(item => <div className="kaino-row" key={`music-${item.id}`}>
              <div className="kaino-row-main"><span className="kaino-row-title">{item.title}</span>
                <span className="kaino-row-meta">Music library</span></div>
              <div className="kaino-row-actions"><button type="button" className="button outline small action" disabled={busy}
                aria-label={`Use ${item.title}`} onClick={() => void select(`kaino:${item.id}`)}>Use</button></div>
            </div>)}
            {sfxTracks.map(item => <div className="kaino-row" key={`sfx-${item.id}`}>
              <div className="kaino-row-main"><span className="kaino-row-title">{item.title}</span>
                <span className="kaino-row-meta">Sound effect</span></div>
              <div className="kaino-row-actions"><button type="button" className="button outline small action" disabled={busy}
                aria-label={`Use ${item.title}`} onClick={() => void select(`kaino-sfx:${item.id}`)}>Use</button></div>
            </div>)}
          </div>
        </div>}
        {!imports.length && !kainoTracks.length && !sfxTracks.length && !checkingSaved &&
          <p className="music-empty">No music yet. Import a file or browse the music library.</p>}
      </div> : <div id="music-library" className="music-library" role="tabpanel">
        <KainoLibrary enabled={visible && panelTab === 'library'} collection={libraryCollection}
          onCollectionChange={setLibraryCollection} canUse={!busy}
          saved={libraryCollection === 'sfx' ? sfxTracks : kainoTracks}
          onSaved={libraryCollection === 'sfx' ? setSfxTracks : setKainoTracks}
          onUse={(item, start) => void select(item, start, libraryCollection)}
          onCacheChange={onKainoCacheChange} />
      </div>}
      {checkingSaved && <MusicLoading label="Checking downloaded tracks…" />}
      {savedError && <div className="music-retry">
        <small role="alert">{savedError}</small>
        <button type="button" className="button outline small"
          onClick={() => setSavedRetry(retry => retry + 1)}>Retry saved tracks</button>
      </div>}
      {(pending || importing) && <MusicLoading label={importing ? 'Importing audio…' : 'Opening track…'} />}
      {failedTrack && <button type="button" className="button outline small" disabled={busy}
        onClick={() => void select(failedTrack)}>Retry opening track</button>}
      {error && <small role="alert">{error}</small>}
      </div>
    </section>
})
