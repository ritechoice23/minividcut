import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import {
  ArrowDownToLine, ArrowUpRight, Check, ChevronDown, Clapperboard, Film, FolderOpen,
  Keyboard, LoaderCircle, Monitor, Move, Pause, Play, Plus, RotateCcw, Scissors, Smartphone,
  Split, Volume2, VolumeX, X,
} from 'lucide-react'
import { MAX_CLIPS, moveBoundary, parseTime, splitRange, stamp, validRange } from './clip'
import type { Clip, Range } from './clip'
import { CENTER, frameTravel, panPosition } from './framing'
import type { FramePosition, Framing } from './framing'
import { fileSize, summarizeExport } from './export-progress'
import type { ExportProgress, ExportState } from './export-progress'

type VideoInfo = { path: string; name: string; duration: number; width: number; height: number }
type Format = 'landscape' | 'portrait'
type Quality = 'compact' | 'compatible' | 'lossless'
type ExportBatch = { ranges: readonly Range[]; states: ExportState[]; running: boolean }

const EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', 'm2ts', 'wmv', 'mpg', 'mpeg', 'ts', '3gp']
const FORMATS = {
  landscape: { ratio: '16:9', aspect: 16 / 9, size: '1920 × 1080', label: 'Landscape', icon: Monitor },
  portrait: { ratio: '9:16', aspect: 9 / 16, size: '1080 × 1920', label: 'Portrait', icon: Smartphone },
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

function Key({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>
}

function ExportBadge({ state }: { state: ExportState }) {
  const label = state.status === 'saved' ? fileSize(state.bytes)
    : state.status === 'encoding' ? `${Math.floor(state.fraction * 100)}%`
    : state.status === 'failed' ? 'Failed' : 'Queued'
  return <span className={`export-badge ${state.status}`} title={state.status === 'failed' ? state.error : undefined}>
    {state.status === 'saved' && <Check size={12} />} {label}
  </span>
}

function TimeField({ label, value, onChange, onMark, disabled }: {
  label: string; value: number; onChange: (time: number) => boolean; onMark: () => void; disabled: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="time-field">
      <span>{label}</span>
      <div className="time-input">
        <input aria-label={label + ' time'} disabled={disabled} spellCheck={false}
          value={draft ?? stamp(value, true)}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== null) onChange(parseTime(draft))
            setDraft(null)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setDraft(null)
          }}
        />
        <button type="button" title={`Set ${label.toLowerCase()} at playhead`} aria-label={`Set ${label.toLowerCase()} at playhead`}
          className="mark-button" onClick={onMark} disabled={disabled}>{label === 'In' ? '[' : ']'}</button>
      </div>
    </div>
  )
}

export function App() {
  const [source, setSource] = useState<VideoInfo | null>(null)
  const [previewPath, setPreviewPath] = useState('')
  const [preview, setPreview] = useState<'direct' | 'preparing' | 'proxy' | 'unavailable'>('direct')
  const [frames, setFrames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [range, setRange] = useState<Range>({ start: 0, end: 0 })
  const [clips, setClips] = useState<Clip[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [format, setFormat] = useState<Format>('landscape')
  const [quality, setQuality] = useState<Quality>('compact')
  const [framing, setFraming] = useState<Framing>('fill')
  const [positions, setPositions] = useState({ landscape: CENTER, portrait: CENTER })
  const [previewAspect, setPreviewAspect] = useState(0)
  const [panning, setPanning] = useState(false)
  const [notice, setNotice] = useState('')
  const [exportBatch, setExportBatch] = useState<ExportBatch | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitMode, setSplitMode] = useState<'mark' | 'add'>('mark')
  const [sections, setSections] = useState<Range[]>([])
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const cancelRename = useRef(false)
  const [clipFrames, setClipFrames] = useState<Record<number, string>>({})
  const frameCache = useRef(new Map<number, string>())
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const trimDrag = useRef<{ range: Range; offset: number } | null>(null)
  const frameDrag = useRef<{ x: number; y: number; travel: FramePosition; position: FramePosition } | null>(null)
  const playUntil = useRef<number | null>(null)
  const sourceRequest = useRef(0)
  const importLock = useRef(false)
  const nextId = useRef(1)
  const fileDialog = useRef(false)
  const exportLock = useRef(false)
  const exportRequest = useRef(0)
  const duration = source?.duration ?? 0
  const hasSource = Boolean(source)
  const busy = exportBatch?.running ?? false
  const activeFormat = FORMATS[format]
  const position = positions[format]
  const travel = previewAspect ? frameTravel(activeFormat.aspect, 1, previewAspect, framing) : { x: 0, y: 0 }
  const positionAxis = Math.abs(travel.x) > 0.001 ? 'x' : Math.abs(travel.y) > 0.001 ? 'y' : null
  const canPosition = Boolean(positionAxis && hasSource && !loading && !busy && preview !== 'preparing' && preview !== 'unavailable')
  const pct = (value: number) => duration ? 100 * value / duration : 0

  const loadVideo = useCallback(async (path: string) => {
    if (exportLock.current || importLock.current) return
    importLock.current = true
    try {
      if (clips.length && !await confirm('Opening a different video clears the clip list.', {
        title: 'Replace video?', kind: 'warning', okLabel: 'Replace video',
      })) return
      setLoading(true)
      setNotice('')
      const info = await invoke<VideoInfo>('open_video', { path })
      const request = ++sourceRequest.current
      if (video.current) {
        video.current.pause()
        if (video.current.readyState > 0) video.current.currentTime = 0
      }
      setSource(info)
      setPreviewPath(info.path)
      setPreview('direct')
      setPreviewAspect(0)
      setPositions({ landscape: CENTER, portrait: CENTER })
      setRange({ start: 0, end: info.duration })
      setTime(0)
      setPlaying(false)
      setClips([])
      setSections([])
      setReviewIndex(null)
      setRenaming(null)
      frameCache.current.clear()
      setClipFrames({})
      setSelectedId(null)
      setFrames([])
      setExportBatch(null)
      setSplitOpen(false)
      void invoke<string[]>('thumbnails', { path: info.path, duration: info.duration })
        .then(images => { if (request === sourceRequest.current) setFrames(images) })
        .catch(() => {})
    } catch (error) {
      setNotice(message(error))
    } finally {
      importLock.current = false
      setLoading(false)
    }
  }, [clips.length])

  const clipStarts = [...new Set(clips.map(clip => clip.start))].join(',')
  useEffect(() => {
    if (!source || !clipStarts || busy) return
    let cancelled = false
    const starts = clipStarts.split(',').map(Number)
    const cache = frameCache.current
    for (const start of cache.keys()) if (!starts.includes(start)) cache.delete(start)
    const pending = starts.filter(start => !cache.has(start))
    async function renderFrames(path: string) {
      for (const start of pending) {
        if (cancelled) break
        const frame = await invoke<string>('clip_thumbnail', { path, start }).catch(() => '')
        if (cancelled) break
        cache.set(start, frame)
        setClipFrames(Object.fromEntries(cache))
      }
    }
    void renderFrames(source.path)
    return () => { cancelled = true }
  }, [source, clipStarts, busy])

  const chooseVideo = useCallback(async () => {
    if (fileDialog.current || exportLock.current || importLock.current) return
    if (!isTauri()) {
      setNotice('Open MiniVidCut as a desktop app to choose a local video.')
      return
    }
    fileDialog.current = true
    try {
      const path = await open({ title: 'Open video', filters: [{ name: 'Video files', extensions: EXTENSIONS }] })
      if (path) await loadVideo(path)
    } catch (error) {
      setNotice(message(error))
    } finally {
      fileDialog.current = false
    }
  }, [loadVideo])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    const listener = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed || exportLock.current) return
      setDragging(payload.type === 'enter' || payload.type === 'over')
      if (payload.type === 'drop') {
        if (payload.paths.length !== 1) setNotice('Drop one video at a time.')
        else void loadVideo(payload.paths[0])
      }
    })
    return () => {
      disposed = true
      void listener.then(unlisten => unlisten())
    }
  }, [loadVideo])

  const useProxy = async () => {
    if (!source || preview === 'preparing' || preview === 'unavailable') return
    if (preview === 'proxy') {
      setPreview('unavailable')
      return
    }
    const request = sourceRequest.current
    setPreview('preparing')
    try {
      const path = await invoke<string>('prepare_preview', { path: source.path })
      if (request !== sourceRequest.current) return
      setPreviewPath(path)
      setPreview('proxy')
    } catch (error) {
      if (request !== sourceRequest.current) return
      setNotice(message(error))
      setPreview('unavailable')
    }
  }

  const seek = (position: number) => {
    if (!source) return
    const next = Math.min(duration, Math.max(0, position))
    const player = video.current
    if (player && player.readyState > 0) player.currentTime = Math.min(next, player.duration)
    setTime(next)
  }

  const togglePlay = () => {
    const player = video.current
    if (!player || player.readyState < 2 || !source) return
    if (!player.paused) {
      player.pause()
      return
    }
    if (player.ended) seek(0)
    const from = player.currentTime
    const saved = clips.find(clip => clip.id === selectedId)
    const reviewed = reviewIndex === null ? undefined : sections[reviewIndex]
    const previewed = saved ?? reviewed
    const playingSection = previewed?.start === range.start && previewed.end === range.end
    playUntil.current = playingSection && from >= range.start && from < range.end - 0.005 ? range.end : null
    void player.play().catch(error => setNotice(message(error)))
  }

  const editBoundary = (side: keyof Range, value: number, original = range) => {
    const next = moveBoundary(original, side, value, duration)
    if (!next) {
      setNotice('Enter a time inside the video.')
      return false
    }
    setRange(next)
    setNotice('')
    return true
  }

  const setFramePosition = (next: FramePosition) => {
    setPositions(current => ({ ...current, [format]: next }))
  }

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canPosition || event.button !== 0) return
    const { width, height } = event.currentTarget.getBoundingClientRect()
    frameDrag.current = {
      x: event.clientX, y: event.clientY, travel: frameTravel(width, height, previewAspect, framing), position,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanning(true)
  }

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = frameDrag.current
    if (!canPosition || !start || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    setFramePosition(panPosition(start.position, start.travel, event.clientX - start.x, event.clientY - start.y))
  }

  const endPan = () => {
    frameDrag.current = null
    setPanning(false)
  }

  const resetRange = () => {
    setSelectedId(null)
    setReviewIndex(null)
    setRange({ start: 0, end: duration })
    setNotice('')
  }

  const addClip = () => {
    if (!validRange(range, duration)) return
    if (selectedId !== null) {
      setClips(items => items.map(clip => clip.id === selectedId ? { ...clip, start: range.start, end: range.end } : clip))
      setSelectedId(null)
      return
    }
    if (clips.length >= MAX_CLIPS) {
      setNotice(`A batch can contain up to ${MAX_CLIPS} clips.`)
      return
    }
    const clip = { ...range, id: nextId.current++ }
    setClips(items => [...items, clip])
    setNotice('')
  }

  const reviewSection = (parts: Range[], index: number) => {
    const section = parts[index]
    if (!section) return
    video.current?.pause()
    setRange(section)
    setSelectedId(null)
    setReviewIndex(index)
    seek(section.start)
  }

  const splitParts = (parts: Range[] | null, selectLast = false) => {
    setSplitOpen(false)
    if (!parts || parts.length < 2) {
      setNotice(parts ? 'Choose an interval shorter than the trim range.' : 'Choose a longer interval to create at most 100 sections.')
      return
    }
    if (splitMode === 'mark') {
      setSections(parts)
      reviewSection(parts, 0)
      setNotice('')
      return
    }
    const replaced = clips.findIndex(clip => clip.id === selectedId)
    if (parts.length + clips.length - (replaced < 0 ? 0 : 1) > MAX_CLIPS) {
      setNotice(`This would exceed ${MAX_CLIPS} clips. Choose a longer interval or a smaller range.`)
      return
    }
    const added = parts.map((part, index) => {
      const title = replaced < 0 ? undefined : clips[replaced].title
      return { ...part, id: nextId.current++, title: title ? `${title} - Part ${index + 1}` : undefined }
    })
    setClips(replaced < 0 ? [...clips, ...added] : [...clips.slice(0, replaced), ...added, ...clips.slice(replaced + 1)])
    setSections([])
    setReviewIndex(null)
    setNotice('')
    if (selectLast) selectClip(added[added.length - 1])
    else setSelectedId(null)
  }

  const splitAtPlayhead = () => {
    setSplitOpen(false)
    const first = { start: range.start, end: time }
    const second = { start: time, end: range.end }
    if (!validRange(first, duration) || !validRange(second, duration)) {
      setNotice('Move the playhead inside the trim range before splitting.')
      return
    }
    splitParts([first, second], true)
  }

  const selectClip = (clip: Clip) => {
    video.current?.pause()
    setRange(clip)
    setSelectedId(clip.id)
    setReviewIndex(null)
    seek(clip.start)
  }

  const renameClip = (id: number, title: string) => {
    const cleaned = title.trim()
    setClips(items => items.map(clip => clip.id === id && (clip.title ?? '') !== cleaned
      ? { ...clip, title: cleaned || undefined } : clip))
    setRenaming(null)
  }

  const beginRename = (id: number) => {
    cancelRename.current = false
    setRenaming(id)
  }

  const exportVideos = async () => {
    if (!source || exportLock.current || importLock.current || fileDialog.current) return
    if (!clips.length && sections.length) return
    const batch = clips.length ? clips : [range]
    if (!batch.every(clip => validRange(clip, duration))) return
    exportLock.current = true
    setNotice('')
    const request = ++exportRequest.current
    let started = false
    try {
      const folder = await open({ directory: true, title: 'Choose where to save your clips' })
      if (!folder) return
      started = true
      setExportBatch({ ranges: batch, states: batch.map(() => ({ status: 'queued' })), running: true })
      const channel = new Channel<ExportProgress>()
      channel.onmessage = ({ index, ...state }) => {
        if (request !== exportRequest.current) return
        setExportBatch(current => {
          if (!current?.running || index < 0 || index >= current.states.length) return current
          const previous = current.states[index]
          if (previous.status === 'saved' || previous.status === 'failed') return current
          if (state.status === 'encoding' && previous.status === 'encoding' && previous.fraction >= state.fraction) return current
          const states = current.states.slice()
          states[index] = state
          return { ...current, states }
        })
      }
      const states = await invoke<ExportState[]>('export_clips', {
        path: source.path, folder, clips: batch.map(clip => ({
          start: clip.start, end: clip.end, title: 'title' in clip ? clip.title : undefined,
        })),
        options: { format, framing, position, quality }, progress: channel,
      })
      setExportBatch({ ranges: batch, states, running: false })
      const failure = states.find(state => state.status === 'failed')
      if (failure) setNotice(failure.error)
    } catch (error) {
      const details = message(error)
      setNotice(details)
      if (started) setExportBatch(current => current && ({
        ...current,
        running: false,
        states: current.states.map(state => state.status === 'saved' || state.status === 'failed'
          ? state : { status: 'failed', error: details }),
      }))
    } finally {
      exportLock.current = false
    }
  }

  useEffect(() => {
    const shortcutsHandler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (event.key === 'Escape') {
        setShortcuts(false)
        setSplitOpen(false)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'o') {
        event.preventDefault()
        void chooseVideo()
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (event.ctrlKey || event.metaKey || event.altKey || shortcuts || !source || loading || busy ||
        target?.closest('input, select, textarea, [contenteditable]')) return
      if (key === 'i' || key === 'o') {
        editBoundary(key === 'i' ? 'start' : 'end', time)
        return
      }
      if (target?.closest('button')) return
      if (key === ' ') { event.preventDefault(); togglePlay() }
      if (key === 'arrowleft' || key === 'arrowright') {
        event.preventDefault()
        seek(time + (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 5 : 1))
      }
      if (key === 'enter' && !event.repeat) addClip()
    }
    window.addEventListener('keydown', shortcutsHandler)
    return () => window.removeEventListener('keydown', shortcutsHandler)
  })

  const scrub = (event: ReactPointerEvent, edge?: keyof Range) => {
    if (!track.current || !source || busy || loading) return
    const rect = track.current.getBoundingClientRect()
    const pointer = (event.clientX - rect.left) / rect.width * duration
    const drag = edge ? trimDrag.current : null
    const time = Math.max(0, Math.min(duration, pointer - (drag?.offset ?? 0)))
    if (edge && drag) editBoundary(edge, time, drag.range)
    seek(time)
  }

  const startScrub = (event: ReactPointerEvent, edge?: keyof Range) => {
    if (!source || !track.current || busy || loading || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    if (edge) {
      const rect = track.current.getBoundingClientRect()
      trimDrag.current = { range, offset: (event.clientX - rect.left) / rect.width * duration - range[edge] }
      seek(range[edge])
    } else scrub(event)
  }

  const disabled = !hasSource || loading || busy
  const canSaveRange = validRange(range, duration)
  const batchCount = clips.length || (hasSource && !sections.length ? 1 : 0)
  const summary = exportBatch && summarizeExport(exportBatch.ranges, exportBatch.states)
  const showingSingleExport = clips.length === 0 && exportBatch?.ranges[0] === range
  const displayedClips: Clip[] = showingSingleExport ? [{ ...range, id: 0 }] : clips
  const exportMatchesList = showingSingleExport || exportBatch?.ranges === clips

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Scissors size={19} /></span><span>MiniVidCut</span></div>
        <div className="top-actions">
          <button className="icon-button shortcuts-button" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => setShortcuts(true)}><Keyboard size={19} /></button>
          <button className="button outline" onClick={() => void chooseVideo()} disabled={busy || loading}><FolderOpen size={16} /> Open video <Key>Ctrl O</Key></button>
          <button className="button primary export" onClick={() => void exportVideos()} disabled={disabled || !batchCount || (!clips.length && !canSaveRange)}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={17} />}
            {busy ? `Exporting ${summary?.percent ?? 0}%` : batchCount ? `Export ${batchCount} ${batchCount === 1 ? 'clip' : 'clips'}` : 'Export'}
          </button>
        </div>
      </header>

      <main className={`workspace ${sections.length ? 'reviewing' : ''}`}>
        <section className="viewer panel" aria-label="Video preview">
          <div className="panel-heading">
            <div className="source-line"><Film size={17} /><span title={source?.name}>{source?.name ?? 'Preview'}</span></div>
            <span className="resolution">{activeFormat.ratio} <span>·</span> {activeFormat.size}</span>
          </div>
          <div className={`stage ${dragging ? 'dragging' : ''}`}>
            {hasSource ? (
              <>
                <div className={`canvas ${format} ${canPosition ? 'can-pan' : ''} ${panning ? 'panning' : ''}`}
                  onPointerDown={startPan} onPointerMove={movePan} onLostPointerCapture={endPan}>
                  {preview !== 'preparing' && preview !== 'unavailable' && (
                    <video key={`${sourceRequest.current}:${previewPath}`} ref={video} className={framing} src={convertFileSrc(previewPath)} muted={muted}
                      preload="auto" playsInline style={{ objectPosition: `${position.x}% ${position.y}%` }}
                      onClick={canPosition ? undefined : togglePlay}
                      onLoadedMetadata={event => {
                        const { videoWidth, videoHeight } = event.currentTarget
                        setPreviewAspect(videoHeight > 0 ? videoWidth / videoHeight : 0)
                        seek(time)
                      }}
                      onTimeUpdate={event => {
                        const player = event.currentTarget
                        const stop = playUntil.current
                        if (!player.paused && stop !== null && player.currentTime >= stop) {
                          player.pause()
                          seek(stop)
                        } else setTime(Math.min(duration, player.currentTime))
                      }}
                      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                      onEnded={() => setPlaying(false)} onError={() => void useProxy()}
                    />
                  )}
                </div>
                {(preview === 'preparing' || preview === 'unavailable') && <div className="stage-message">
                  {preview === 'preparing' && <LoaderCircle size={24} className="spin" />}
                  {preview === 'preparing' ? 'Preparing a playable preview…' : 'Preview unavailable. You can still set times and export.'}
                </div>}
              </>
            ) : (
              <div className="import">
                <div className="import-graphic" aria-hidden="true"><div /><div /><span><Clapperboard size={31} strokeWidth={1.5} /></span></div>
                <h1>Drop a video here</h1>
                <p>Mark the moments you want to keep.</p>
                <button className="button primary browse" onClick={() => void chooseVideo()} disabled={loading}>
                  {loading ? <LoaderCircle size={17} className="spin" /> : <FolderOpen size={17} />} {loading ? 'Opening video…' : 'Browse files'}
                </button>
                <span className="file-types">MP4, MOV, MKV, WebM and more</span>
              </div>
            )}
            {dragging && <div className="drop-overlay"><FolderOpen size={28} /> Drop to open video</div>}
          </div>
          <div className="transport">
            <button className="icon-button play" aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={togglePlay} disabled={!source || preview === 'preparing' || preview === 'unavailable'}>
              {playing ? <Pause size={19} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <span className="clock"><strong>{stamp(time, true)}</strong><span>/</span>{stamp(duration)}</span>
            {canPosition && positionAxis && <div className="position-controls">
              <label title="Drag the preview or use the slider to position every exported clip"><Move size={15} />
                <span>Position</span>
                <input aria-label={positionAxis === 'x' ? 'Horizontal frame position' : 'Vertical frame position'}
                  type="range" min="0" max="100" value={position[positionAxis]}
                  onChange={event => setFramePosition({ ...position, [positionAxis]: Number(event.target.value) })} />
              </label>
              <button className="button outline small" title="Center picture in frame" onClick={() => setFramePosition(CENTER)}>Center</button>
            </div>}
            <button className="icon-button mute" aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} disabled={!source} onClick={() => setMuted(!muted)}>
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
          </div>
          <div className="output-bar">
            <div className="segmented format-options" role="group" aria-label="Output format">
              {(Object.keys(FORMATS) as Format[]).map(option => {
                const { icon: Icon, label, ratio } = FORMATS[option]
                return <button key={option} title={`${label} ${ratio}`} aria-pressed={option === format} disabled={busy}
                  onClick={() => setFormat(option)}><Icon size={14} /><span>{label}</span></button>
              })}
            </div>
            <div className="segmented" role="group" aria-label="Framing">
              <button aria-pressed={framing === 'fill'} title="Crop to fill the frame" disabled={busy} onClick={() => setFraming('fill')}>Fill</button>
              <button aria-pressed={framing === 'fit'} title="Keep the full image with black borders" disabled={busy} onClick={() => setFraming('fit')}>Fit</button>
            </div>
            <label className="file-size">
              <span>File size</span>
              <select value={quality} disabled={busy} onChange={event => setQuality(event.target.value as Quality)}>
                <option value="compact">Compact (H.265)</option>
                <option value="compatible">Compatible (H.264)</option>
                <option value="lossless">Lossless video (large)</option>
              </select>
            </label>
          </div>
        </section>

        <aside className="queue panel" aria-label="Clips">
          <div className="panel-heading">
            <div className="source-line"><Clapperboard size={16} /><h2>Clips</h2><span className="count">{displayedClips.length}</span></div>
            {displayedClips.length > 0 && <span className="queue-duration" title="Total clip duration">{stamp(displayedClips.reduce((total, clip) => total + clip.end - clip.start, 0), true)}</span>}
          </div>
          {summary && <section className="export-summary" aria-label="Batch export">
            <div className="export-heading">
              <strong>{busy ? 'Exporting clips' : summary.failed ? 'Export finished with errors' : 'Export complete'}</strong>
              <span>{busy ? `${summary.percent}%` : summary.bytes > 0 ? fileSize(summary.bytes) : null}</span>
            </div>
            <div className={`batch-meter ${summary.failed ? 'has-errors' : ''}`} role="progressbar"
              aria-label="Overall export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}>
              <span style={{ width: `${summary.percent}%` }} />
            </div>
            <div className="export-detail">
              <span>{summary.saved} of {summary.total} saved{summary.active > 0 && ` · ${summary.active} exporting`}{summary.failed > 0 && ` · ${summary.failed} failed`}</span>
              {!busy && summary.saved > 0 && <button className="text-button" onClick={() => void invoke('open_export_folder').catch(error => setNotice(message(error)))}>Open folder <ArrowUpRight size={13} /></button>}
            </div>
          </section>}
          {displayedClips.length === 0 ? <div className="empty-queue"><Scissors size={20} strokeWidth={1.5} /><span>No clips added</span><p>Add a trim range or split it into clips.</p></div> :
            <ol className="clip-list">{displayedClips.map((clip, index) => {
              const state = exportMatchesList ? exportBatch?.states[index] : undefined
              const title = clip.title ?? `Clip ${String(index + 1).padStart(2, '0')}`
              return <li key={clip.id} className={clip.id === selectedId ? 'selected' : ''}>
                {renaming === clip.id ? <div className="clip-rename">
                  <input autoFocus aria-label={`Rename ${title}`} maxLength={80} defaultValue={title}
                    onFocus={event => event.currentTarget.select()}
                    onBlur={event => {
                      if (cancelRename.current) return
                      renameClip(clip.id, event.target.value === title && !clip.title ? '' : event.target.value)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        cancelRename.current = true
                        setRenaming(null)
                      }
                    }} />
                </div> : <button className="clip-select" aria-pressed={clip.id === selectedId} disabled={disabled || showingSingleExport}
                  title={showingSingleExport ? title : `${title} · Double-click to rename`}
                  onClick={() => selectClip(clip)} onDoubleClick={() => beginRename(clip.id)}
                  onKeyDown={event => {
                    if (event.key === 'F2') { event.preventDefault(); beginRename(clip.id) }
                  }}>
                  <span className="clip-icon">{clipFrames[clip.start] ? <img alt="" src={clipFrames[clip.start]} /> : <Film size={15} />}</span>
                  <span><strong>{title}</strong><small>{stamp(clip.start, true)} – {stamp(clip.end, true)}</small></span>
                </button>}
                {state && <ExportBadge state={state} />}
                {!busy && !showingSingleExport && <button className="icon-button compact" aria-label={`Remove clip ${index + 1}`} title="Remove clip" disabled={disabled} onClick={() => {
                  setClips(items => items.filter(item => item.id !== clip.id))
                  if (selectedId === clip.id) setSelectedId(null)
                }}><X size={15} /></button>}
                {state?.status === 'encoding' && <div className="clip-meter" aria-hidden="true"><span style={{ width: `${state.fraction * 100}%` }} /></div>}
              </li>
            })}</ol>}
        </aside>

        <section className="timeline panel" aria-label="Timeline">
          <div className="panel-heading timeline-heading">
            <div className="source-line"><Scissors size={17} /><span>Timeline</span></div>
            <div className="split">
              <button className="button outline small" disabled={disabled || !canSaveRange} onClick={() => setSplitOpen(!splitOpen)} aria-expanded={splitOpen}><Split size={15} /> Split range <ChevronDown size={13} /></button>
              {splitOpen && canSaveRange && !disabled && <div className="split-menu">
                <div className="segmented split-mode" role="group" aria-label="Split behavior">
                  <button aria-pressed={splitMode === 'mark'} onClick={() => setSplitMode('mark')}>Mark only</button>
                  <button aria-pressed={splitMode === 'add'} onClick={() => setSplitMode('add')}>Split &amp; add</button>
                </div>
                <button onClick={splitAtPlayhead}>At playhead</button>{[15, 30, 60, 120, 300].map(seconds =>
                  <button key={seconds} onClick={() => splitParts(splitRange(range, seconds))}>{seconds < 60 ? `Every ${seconds}s` : `Every ${seconds / 60} min`}</button>)}
              </div>}
            </div>
          </div>
          <div className="timeline-body">
            <div className="ruler" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(step => <span key={step}>{duration ? stamp(duration * step / 5) : step === 0 ? '00:00:00' : ''}</span>)}</div>
            <div className={`track ${hasSource ? 'loaded' : ''}`} ref={track} onPointerDown={event => startScrub(event)}
              onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event) }}>
              {hasSource ? (
                <>
                  <div className="frames">{Array.from({ length: 10 }, (_, index) => frames[index] ? <img draggable={false} alt="" key={index} src={frames[index]} /> : <span key={index} />)}</div>
                  <div className="range-shade" style={{ width: `${pct(range.start)}%` }} />
                  <div className="range-shade right" style={{ width: `${100 - pct(range.end)}%` }} />
                  <div className="selection" style={{ left: `${pct(range.start)}%`, width: `${pct(range.end - range.start)}%` }} />
                  {sections.slice(1).map(section => <div className="section-mark" key={section.start} style={{ left: `${pct(section.start)}%` }} />)}
                  {(['start', 'end'] as const).map(edge => <button key={edge} className={`handle ${edge}`} disabled={disabled}
                    aria-label={edge === 'start' ? 'Drag trim start' : 'Drag trim end'}
                    data-tight={pct(range.end - range.start) < 5}
                    style={{ left: `clamp(0px, calc(${pct(range[edge])}% - ${edge === 'end' ? 11 : 0}px), calc(100% - 11px))` }}
                    onPointerDown={event => startScrub(event, edge)}
                    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event, edge) }}
                    onLostPointerCapture={() => { trimDrag.current = null }}
                    onKeyDown={event => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      const change = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1)
                      const value = Math.max(0, Math.min(duration, range[edge] + change))
                      if (editBoundary(edge, value)) seek(value)
                    }}><span /></button>)}
                  <div className="playhead" style={{ left: `${pct(time)}%` }}><span /></div>
                </>
              ) : <span className="empty-track"><Film size={16} /> Open a video to start trimming</span>}
            </div>
            {clips.length > 0 && <div className="clip-strip" aria-label="Saved clip ranges">
              {clips.map((clip, index) => <button key={clip.id} className={clip.id === selectedId ? 'selected' : ''}
                title={`Clip ${index + 1} · ${stamp(clip.start, true)} – ${stamp(clip.end, true)}`}
                aria-label={`Select clip ${index + 1} on timeline`} disabled={disabled}
                style={{ left: `${pct(clip.start)}%`, width: `${pct(clip.end - clip.start)}%` }}
                onClick={() => selectClip(clip)} />)}
            </div>}
            {source && <input className="accessible-scrubber" aria-label="Playhead time" type="range" min={0} max={duration} step="any" value={time} onChange={event => seek(Number(event.target.value))} />}
          </div>
          <div className="trim-bar" role="group" aria-label="Trim range">
            <TimeField label="In" value={range.start} disabled={disabled} onChange={value => editBoundary('start', value)} onMark={() => editBoundary('start', time)} />
            <TimeField label="Out" value={range.end} disabled={disabled} onChange={value => editBoundary('end', value)} onMark={() => editBoundary('end', time)} />
            <button className="icon-button compact" title="Reset trim range" aria-label="Reset trim range" onClick={resetRange} disabled={disabled}><RotateCcw size={15} /></button>
            {hasSource && <span className="range-duration" title={canSaveRange ? 'Trim range duration' : 'A clip must be at least 0.05 seconds long'}>{stamp(range.end - range.start, true)}</span>}
            <button className="button add" disabled={disabled || !canSaveRange} onClick={addClip}>{selectedId === null ? <Plus size={16} /> : <Check size={16} />}{selectedId === null ? 'Add clip' : 'Update clip'}</button>
          </div>
          {sections.length > 0 && <div className="section-review" role="group" aria-label="Review marked sections">
            <button className="button outline small" disabled={disabled || reviewIndex === 0} onClick={() => reviewSection(sections, reviewIndex === null ? sections.length - 1 : reviewIndex - 1)}>Previous</button>
            <label><span className="sr-only">Marked section</span><select value={reviewIndex ?? ''} disabled={disabled} onChange={event => reviewSection(sections, Number(event.target.value))}>
              <option value="" disabled>Review {sections.length} sections</option>
              {sections.map((section, index) => <option key={section.start} value={index}>Section {index + 1} of {sections.length} · {stamp(section.start)}</option>)}
            </select></label>
            <button className="button outline small" disabled={disabled || reviewIndex === sections.length - 1} onClick={() => reviewSection(sections, reviewIndex === null ? 0 : reviewIndex + 1)}>Next</button>
            <button className="text-button" disabled={disabled} onClick={() => { setSections([]); setReviewIndex(null) }}>Clear marks</button>
          </div>}
        </section>
      </main>

      <footer className="statusbar">
        <div className="status-left" role="status"><span className={`status-dot ${notice ? 'error' : ''}`} />
          {notice || (loading ? 'Reading video…' : summary ? `Saved ${summary.saved} of ${summary.total} clips` : 'Local editing')}
        </div>
        <button className="text-button footer-shortcuts" onClick={() => setShortcuts(true)}><Keyboard size={15} /> Shortcuts</button>
      </footer>
      {shortcuts && <div className="dialog-backdrop" onClick={() => setShortcuts(false)}>
        <section className="shortcut-dialog panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={event => event.stopPropagation()}>
          <div className="section-title"><h2>Keyboard shortcuts</h2><button autoFocus className="icon-button" aria-label="Close shortcuts" onClick={() => setShortcuts(false)}><X size={18} /></button></div>
          <dl>{[['Open video', 'Ctrl O'], ['Play / pause', 'Space'], ['Seek 1 second', '← / →'], ['Seek 5 seconds', 'Shift ← / →'], ['Mark In', 'I'], ['Mark Out', 'O'], ['Add or update clip', 'Enter']].map(([label, key]) =>
            <div key={label}><dt>{label}</dt><dd><Key>{key}</Key></dd></div>)}</dl>
        </section>
      </div>}
    </div>
  )
}
