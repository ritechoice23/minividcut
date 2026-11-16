import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import {
  ArrowDownToLine, Check, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Copy, Ellipsis, FastForward, Film, FolderOpen, Rewind,
  Keyboard, LoaderCircle, Magnet, Minus, Monitor, Move, Music2, Pause, Pencil, Play, Plus, RotateCcw, Scissors, Smartphone, Square,
  Redo2, ScissorsLineDashed, Settings as SettingsIcon, Sparkles, Split, Subtitles, Trash2, Undo2, Volume2, VolumeX, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import {
  clipDuration, clipSegments, cutRange, exportUnits, MAX_CLIPS, moveBoundary, normalizeClip, parseTime,
  rangesOverlap, resizeClipEdge, segmentAt, splitClipAt, splitRange, stamp, trimClips, validRange, withSegments,
} from './clip'
import type { Clip, Range } from './clip'
import { MAX_TIMELINE_ZOOM, panTimeline, snapTime, timelineFrames, timelineOverlaps, timelineTime, timelineWindow, ZOOM_STEPS, zoomAround, zoomTimeline } from './timeline'
import { buildSequenceMap, clipSpans, reorderClips, sequenceAtSource, sourceAtSequence } from './sequence-timeline'
import { CENTER, frameTravel, panPosition } from './framing'
import type { FramePosition, Framing } from './framing'
import { fileSize, groupExportStates, summarizeExport } from './export-progress'
import type { ExportProgress, ExportState } from './export-progress'
import { ClipActions } from './ClipActions'
import { Settings } from './Settings'
import { CaptionEditor, CaptionStylePanel, progressLabel } from './CaptionEditor'
import { CaptionPreview } from './CaptionPreview'
import { prepareCaptionOverlay } from './caption-export'
import type { CaptionModel, CaptionProgress } from './CaptionEditor'
import { captionCut, captionSlice, clipsNeedingCaptions, DEFAULT_CAPTION_STYLE, offsetCaption, restyleCaptionedClip } from './captions'
import type { CaptionCue, CaptionStyle, CaptionTrack } from './captions'
import { DEFAULT_MOMENT_QUERY, missingTranscriptRanges, MOMENT_BATCH_SECONDS, momentCandidates, momentLimit } from './moments'
import type { Moment } from './moments'
import { MusicMenu } from './MusicMenu'
import { effectiveMusic, kainoKey, musicGain, musicPosition } from './music'
import type { KainoCollection, Music, MusicTrack } from './music'
import { BookendsMenu } from './BookendsMenu'
import { effectiveBookends } from './bookends'
import { useSequenceCompositor } from './sequence-compositor'
import { activeTime, playbackClock, useEditor, usePlaybackTime } from './editor-store'
import type { Bookend, Bookends } from './bookends'

type VideoInfo = { path: string; name: string; duration: number; width: number; height: number; bytes: number }
type Format = 'landscape' | 'portrait'
type Quality = 'compact' | 'compatible' | 'lossless'
type ExportSettings = { format: Format; framing: Framing; position: FramePosition; quality: Quality }
type Draft = {
  version: 2; source: VideoInfo; range: Range; clips: Clip[]; sections: Range[]
  format: Format; quality: Quality; framing: Framing; positions: Record<Format, FramePosition>
  captions: Record<string, CaptionTrack | undefined>; captionStyle: CaptionStyle | null
  music?: Music | null
  bookends?: Bookends
}
const DRAFT_KEY = 'minividcut.draft'
const AUTO_TITLES_KEY = 'minividcut.auto-titles'
const TITLE_DOWNLOAD_KEY = 'minividcut.title-download-allowed'

function readDraft(): Draft | null {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')
    if ((saved?.version !== 1 && saved?.version !== 2) || typeof saved?.source?.path !== 'string') return null
    const length = saved.source.duration
    const clips = Array.isArray(saved.clips)
      ? saved.clips.map((clip: Clip) => Number.isFinite(length) ? normalizeClip(clip, length) : clip).filter(Boolean)
      : []
    return { ...saved, version: 2, clips }
  } catch {
    return null
  }
}

type ExportBatch = {
  ranges: readonly Clip[]; states: ExportState[]; weights: Range[]; running: boolean; options: ExportSettings
}

const EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', 'm2ts', 'wmv', 'mpg', 'mpeg', 'ts', '3gp']
const FORMATS = {
  landscape: { ratio: '16:9', aspect: 16 / 9, size: '1920 × 1080', label: 'Landscape', icon: Monitor },
  portrait: { ratio: '9:16', aspect: 9 / 16, size: '1080 × 1920', label: 'Portrait', icon: Smartphone },
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const trackKey = (track: MusicTrack) => track.kind === 'file' ? `file:${track.path}`
  : track.kind === 'kaino' ? kainoKey(track.id, track.collection) : `${track.kind}:${track.id}`

function Key({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>
}

function ClockDisplay({ duration }: { duration: number }) {
  const time = usePlaybackTime()
  const sequenceTime = useEditor(state => state.sequenceTime)
  const sequenceDuration = useEditor(state => state.sequenceDuration)
  const sequenceActive = useEditor(state => state.sequenceActive)
  return <span className="clock"><strong>{stamp(sequenceActive ? sequenceTime : time, true)}</strong><span>/</span>{stamp(sequenceActive ? sequenceDuration : duration)}</span>
}

function TimelinePlayhead({ pct, inView, onDrag, onMove }: {
  pct: (value: number) => number; inView: (value: number) => boolean
  onDrag: (event: ReactPointerEvent) => void; onMove: (event: ReactPointerEvent) => void
}) {
  const time = usePlaybackTime()
  if (!inView(time)) return null
  return <div className="playhead" style={{ left: `${pct(time)}%` }}>
    <span className="playhead-grip" title="Drag to seek" aria-hidden="true"
      onPointerDown={onDrag} onPointerMove={onMove} />
  </div>
}

function AccessibleScrubber({ duration, seek }: { duration: number; seek: (time: number) => void }) {
  const time = usePlaybackTime()
  return <input className="accessible-scrubber" aria-label="Playhead time" type="range"
    min={0} max={duration} step="any" value={time} onChange={event => seek(Number(event.target.value))} />
}

function ExportBadge({ state }: { state: ExportState }) {
  const device = state.status === 'saved'
    ? (state.encoder.startsWith('lib') ? 'CPU' : 'GPU')
    : undefined
  const label = state.status === 'saved' ? `${fileSize(state.bytes)} · ${device}`
    : state.status === 'encoding' ? `${Math.floor(state.fraction * 100)}%`
    : state.status === 'failed' ? 'Failed' : state.status === 'canceled' ? 'Canceled' : 'Queued'
  const title = state.status === 'failed' ? state.error
    : state.status === 'saved' ? `Encoded on ${device} (${state.encoder})` : undefined
  return <span className={`export-badge ${state.status}`} title={title}>
    {state.status === 'saved' && <Check size={12} />} {label}
  </span>
}

const CLIP_COLORS = ['#78bfff', '#d4a0ff', '#f5bb70', '#7fe0b6', '#ff9db4', '#a6c9ff', '#e8d982', '#9bdfec', '#efad87', '#c3e887', '#e7a4e9', '#a5a8ff']
const clipColor = (id: number) => CLIP_COLORS[Math.max(0, id - 1) % CLIP_COLORS.length]

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recovery, setRecovery] = useState(readDraft)
  const [cancelingExport, setCancelingExport] = useState(false)
  const cancelRequested = useRef(false)
  const exportReady = useRef<string | null>(null)
  const [source, setSource] = useState<VideoInfo | null>(null)
  const [previewPath, setPreviewPath] = useState('')
  const [preview, setPreview] = useState<'direct' | 'preparing' | 'proxy' | 'unavailable'>('direct')
  const [frames, setFrames] = useState<Record<string, string>>({})
  const framesRef = useRef(frames)
  framesRef.current = frames
  const framesInFlight = useRef(new Set<string>())
  const timelineScroll = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [range, setRange] = useState<Range>({ start: 0, end: 0 })
  const [clips, setClips] = useState<Clip[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [snapping, setSnapping] = useState(true)
  const [timelineView, setTimelineView] = useState<'source' | 'sequence'>('source')
  const [reorderTarget, setReorderTarget] = useState<number | null>(null)
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [timelineStart, setTimelineStart] = useState(0)
  const timelinePanned = useRef(false)
  const timelineDrag = useRef<{ x: number; start: number; width: number; moved: boolean } | null>(null)
  const clipReorder = useRef<{ index: number; x: number; moved: boolean } | null>(null)
  const reorderTargetRef = useRef<number | null>(null)
  const reorderMoved = useRef(false)
  const [grabbingTimeline, setGrabbingTimeline] = useState(false)
  const timelineBody = useRef<HTMLDivElement>(null)
  const wheelView = useRef({ duration: 0, zoom: 1, start: 0, span: 0 })
  const wheelZoomAccum = useRef(0)
  const [playing, setPlaying] = useState(false)
  const sequencePlaying = useEditor(state => state.sequencePlaying)
  const [muted, setMuted] = useState(false)
  const [previewVolume, setPreviewVolume] = useState(100)
  const [projectMusic, setProjectMusic] = useState<Music | null>(null)
  const [musicCacheRevision, setMusicCacheRevision] = useState(0)
  const [projectBookends, setProjectBookends] = useState<Bookends>({})
  const musicPlayer = useRef<HTMLAudioElement>(null)
  const setMusicPlayer = useCallback((audio: HTMLAudioElement | null) => {
    if (musicPlayer.current !== audio) musicPlayer.current?.pause()
    musicPlayer.current = audio
  }, [])
  const musicPaths = useRef(new Map<string, string>())
  const [previewMusic, setPreviewMusic] = useState<{ key: string; path: string } | null>(null)
  const [draftFormat, setFormat] = useState<Format>('landscape')
  const [draftQuality, setQuality] = useState<Quality>('compact')
  const [draftFraming, setFraming] = useState<Framing>('fill')
  const [positions, setPositions] = useState({ landscape: CENTER, portrait: CENTER })
  const [previewAspect, setPreviewAspect] = useState(0)
  const [panning, setPanning] = useState(false)
  const exportMenu = useRef<HTMLFormElement>(null)
  const [selectedExportOnly, setSelectedExportOnly] = useState(false)
  const [notice, setNotice] = useState('')
  const [editStatus, setEditStatus] = useState('')
  const [autoTitles, setAutoTitles] = useState(() => localStorage.getItem(AUTO_TITLES_KEY) === 'on')
  const [titleProgress, setTitleProgress] = useState('')
  const [titleError, setTitleError] = useState('')
  const [requestedTitle, setRequestedTitle] = useState<{ id: number; sourceRevision: number } | null>(null)
  const [maximized, setMaximized] = useState(false)
  const titleJob = useRef(false)
  const titledClips = useRef(new Set<string>())
  const [exportBatch, setExportBatch] = useState<ExportBatch | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitMode, setSplitMode] = useState<'mark' | 'add'>('mark')
  const [sections, setSections] = useState<Range[]>([])
  const [momentsOpen, setMomentsOpen] = useState(false)
  const [styleDockKey, setStyleDockKey] = useState<string | null>(null)
  const [mediaDock, setMediaDock] = useState<'music' | 'bookends' | null>(null)
  const [wideWorkspace, setWideWorkspace] = useState(() => matchMedia('(min-width: 1120px)').matches)
  const momentsTrigger = useRef<HTMLButtonElement>(null)
  const [moments, setMoments] = useState<Moment[]>([])
  const [momentStatus, setMomentStatus] = useState('')
  const [momentRunning, setMomentRunning] = useState(false)
  const [momentProgress, setMomentProgress] = useState<number | null>(null)
  const [momentStopping, setMomentStopping] = useState(false)
  const momentJob = useRef<{ canceled: boolean; transcribing: boolean } | null>(null)
  const momentCache = useRef<{
    revision: number
    batches: { range: Range; cues: CaptionCue[] }[]
    matches: Map<string, number | null>
  }>({ revision: 0, batches: [], matches: new Map() })
  const playingMoment = useRef<Moment | null>(null)
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [clipActions, setClipActions] = useState<number | null>(null)
  const closeClipActions = useCallback(() => setClipActions(null), [])
  const renameClick = useRef<number | null>(null)
  const [clipFrames, setClipFrames] = useState<Record<number, string>>({})
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const [captionModel, setCaptionModel] = useState<CaptionModel | null>(null)
  const [captionProgress, setCaptionProgress] = useState<CaptionProgress | null>(null)
  const [captionStatus, setCaptionStatus] = useState<{ key: string; text: string } | null>(null)
  const [draftCaptions, setDraftCaptions] = useState<Record<string, CaptionTrack | undefined>>({})
  const sharedCaptionStyle = useRef<CaptionStyle | null>(null)
  const clipsTab = useRef<HTMLButtonElement>(null)
  const captionsTab = useRef<HTMLButtonElement>(null)
  const captionJob = useRef<{ keys: Set<string>; cancelled: boolean } | null>(null)
  const frameCache = useRef(new Map<number, string>())
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const trimDrag = useRef<{ range: Range; offset: number } | null>(null)
  const clipEdgeDrag = useRef<{ clip: Clip; side: 'start' | 'end'; axisPointer: number; value: number; recorded: boolean } | null>(null)
  const playheadOffset = useRef(0)
  const frameDrag = useRef<{ x: number; y: number; travel: FramePosition; position: FramePosition } | null>(null)
  const playUntil = useRef<number | null>(null)
  const ignoreTimeUpdateUntil = useRef(0)
  const sourceRequest = useRef(0)
  const importLock = useRef(false)
  const nextId = useRef(1)
  const fileDialog = useRef(false)
  const exportLock = useRef(false)
  const exportRequest = useRef(0)
  const duration = source?.duration ?? 0
  const hasSource = Boolean(source)
  const busy = exportBatch?.running ?? false
  const batchIndices = new Map(exportBatch?.ranges.map((clip, index) => [clip.id, index]))
  const clipLocked = (id: number) => busy && batchIndices.has(id)
  const selectedLocked = selectedId !== null && clipLocked(selectedId)
  const lockedOptions = selectedLocked ? exportBatch?.options : undefined
  const format = lockedOptions?.format ?? draftFormat
  const framing = lockedOptions?.framing ?? draftFraming
  const activeFormat = FORMATS[format]
  const position = lockedOptions?.position ?? positions[format]
  const objectPosition = `${position.x}% ${position.y}%`
  const travel = previewAspect ? frameTravel(activeFormat.aspect, 1, previewAspect, framing) : { x: 0, y: 0 }
  const positionAxis = Math.abs(travel.x) > 0.001 ? 'x' : Math.abs(travel.y) > 0.001 ? 'y' : null
  const canPosition = Boolean(positionAxis && hasSource && !loading && !selectedLocked && preview !== 'preparing' && preview !== 'unavailable')
  const sequenceMap = useMemo(() => buildSequenceMap(clips), [clips])
  const sequenceSpans = useMemo(() => clipSpans(sequenceMap, clips), [sequenceMap, clips])
  const axisDuration = timelineView === 'sequence' ? sequenceMap.duration : duration
  const visibleTime = timelineWindow(axisDuration, timelineZoom, timelineStart)
  wheelView.current = { duration: axisDuration, zoom: timelineZoom, start: visibleTime.start, span: visibleTime.span }
  const toSource = (axisTime: number) => timelineView === 'sequence'
    ? (sourceAtSequence(sequenceMap, axisTime)?.time ?? axisTime) : axisTime
  const toAxis = (sourceTime: number) => timelineView === 'sequence'
    ? (sequenceAtSource(sequenceMap, sourceTime) ?? 0) : sourceTime
  const pct = (value: number) => visibleTime.span
    ? Math.max(0, Math.min(100, 100 * (value - visibleTime.start) / visibleTime.span)) : 0
  const filmTiles = timelineFrames(axisDuration, timelineZoom, visibleTime.start)
  const overviewTiles = timelineFrames(duration, 1, 0)
  const tileTimes = filmTiles.map(tile => tile.time).join(',')
  const overlaps = useMemo(() => timelineOverlaps(clips.flatMap(clipSegments)), [clips])
  useEffect(() => {
    // While zoomed playback pans the viewport, defer thumbnail work until the
    // user pauses instead of launching an FFmpeg batch on every time tick.
    if (!source || !tileTimes || (playing && timelineZoom > 1)) return
    const times = tileTimes.split(',').map(Number)
      .filter(time => !(String(time) in framesRef.current) && !framesInFlight.current.has(String(time)))
    if (!times.length) return
    const keys = times.map(String)
    keys.forEach(key => framesInFlight.current.add(key))
    let active = true
    const timer = window.setTimeout(() => {
      void invoke<string[]>('thumbnails', { path: source.path, duration: source.duration, times })
        .then(images => {
          if (!active) return
          const next = { ...framesRef.current }
          times.forEach((time, index) => { next[time] = images[index] ?? '' })
          const existing = Object.keys(next)
          for (const key of existing.slice(0, Math.max(0, existing.length - 240))) delete next[key]
          framesRef.current = next
          setFrames(next)
        }).catch(() => {}).finally(() => {
          keys.forEach(key => framesInFlight.current.delete(key))
        })
    }, 140)
    return () => {
      active = false
      window.clearTimeout(timer)
      keys.forEach(key => framesInFlight.current.delete(key))
    }
  }, [source, tileTimes, playing, timelineZoom])
  useEffect(() => {
    const bar = timelineScroll.current
    if (!bar || !visibleTime.maxStart) return
    const left = (bar.scrollWidth - bar.clientWidth) * visibleTime.start / visibleTime.maxStart
    if (Math.abs(bar.scrollLeft - left) > 1) bar.scrollLeft = left
  }, [visibleTime.start, visibleTime.maxStart, timelineZoom])
  const inView = (value: number) => value >= visibleTime.start - 0.000001 && value <= visibleTime.end + 0.000001
  const snap = (value: number) => {
    if (!snapping) return value
    const points = [0, duration, playbackClock.get(),
      ...clips.flatMap(clip => clipSegments(clip).flatMap(segment => [segment.start, segment.end])),
      ...sections.flatMap(section => [section.start, section.end])]
    return snapTime(value, points, visibleTime.span * 0.01)
  }
  const setPlaybackTime = useCallback((value: number) => {
    playbackClock.set(value)
    if (timelinePanned.current) return
    const axis = timelineView === 'sequence' ? (sequenceAtSource(sequenceMap, value) ?? visibleTime.start) : value
    setTimelineStart(start => {
      const visible = timelineWindow(axisDuration, timelineZoom, start)
      if (axis >= visible.start - 0.000001 && axis <= visible.end + 0.000001) return start
      return zoomTimeline(axisDuration, timelineZoom, axis)
    })
  }, [axisDuration, timelineZoom, timelineView, sequenceMap, visibleTime.start])
  const zoomTimelineTo = (requested: number) => {
    const zoom = Math.max(1, Math.min(MAX_TIMELINE_ZOOM, requested))
    if (zoom === timelineZoom) return
    const axisNow = toAxis(playbackClock.get())
    const anchor = inView(axisNow) ? axisNow : (visibleTime.start + visibleTime.end) / 2
    setTimelineZoom(zoom)
    setTimelineStart(zoomTimeline(axisDuration, zoom, anchor))
  }
  const revealTimelineTime = (point: number) => {
    timelinePanned.current = false
    const axis = toAxis(point)
    if (!inView(axis)) setTimelineStart(zoomTimeline(axisDuration, timelineZoom, axis))
  }

  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setTimeout(() => { void invoke('warm_encoders').catch(() => {}) }, 1500)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const layout = matchMedia('(min-width: 1120px)')
    const update = () => setWideWorkspace(layout.matches)
    layout.addEventListener('change', update)
    return () => layout.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const window = getCurrentWindow()
    let active = true
    const refresh = () => void window.isMaximized().then(value => { if (active) setMaximized(value) }).catch(() => {})
    const listener = window.onResized(refresh)
    refresh()
    return () => {
      active = false
      void listener.then(unlisten => unlisten()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const body = timelineBody.current
    if (!body) return
    const scrollTimeline = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('input')) return
      const view = wheelView.current
      if (!body.clientWidth) return
      const zooming = event.ctrlKey || event.metaKey
      // Plain vertical wheel is inert (it used to make the filmstrip dance).
      // Shift + wheel and horizontal trackpad swipes pan the viewport.
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!zooming && !horizontal) return
      const delta = zooming ? (event.deltaY || event.deltaX)
        : event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX
      if (!delta) return
      event.preventDefault()
      timelinePanned.current = true
      const pixels = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * body.clientWidth : delta
      if (!zooming) {
        if (view.zoom === 1) return
        setTimelineStart(start => panTimeline(view.duration, view.zoom, start, pixels / body.clientWidth))
        return
      }
      wheelZoomAccum.current += -pixels
      if (Math.abs(wheelZoomAccum.current) < 45) return
      const direction = Math.sign(wheelZoomAccum.current)
      wheelZoomAccum.current = 0
      const level = ZOOM_STEPS.findIndex(step => step >= view.zoom - 0.0001)
      const nextLevel = Math.max(0, Math.min(ZOOM_STEPS.length - 1, level + direction))
      const zoom = ZOOM_STEPS[nextLevel]
      if (zoom === view.zoom) return
      const rect = body.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      const anchor = timelineTime(view.start, view.span, fraction)
      const start = zoomAround(view.duration, zoom, anchor, fraction)
      // Keep the ref in sync so rapid wheel ticks accumulate instead of
      // each one restarting from the last rendered zoom.
      wheelView.current = { ...view, zoom, start, span: view.duration / zoom }
      setTimelineZoom(zoom)
      setTimelineStart(start)
    }
    body.addEventListener('wheel', scrollTimeline, { passive: false })
    return () => body.removeEventListener('wheel', scrollTimeline)
  }, [])
  const selectedClip = clips.find(clip => clip.id === selectedId)

  // Editing history is a snapshot of the timeline state, not of playback.
  // record() is called before a mutation so undo restores the previous state.
  type EditSnapshot = {
    range: Range; clips: Clip[]; sections: Range[]; draftCaptions: Record<string, CaptionTrack | undefined>
    selectedId: number | null; reviewIndex: number | null
  }
  const past = useRef<EditSnapshot[]>([])
  const future = useRef<EditSnapshot[]>([])
  const captionEditAt = useRef(0)
  const [, setHistoryRevision] = useState(0)
  // Read through a ref so memoized callbacks always snapshot the latest state.
  const editorState = useRef({ range, clips, sections, draftCaptions, selectedId, reviewIndex })
  editorState.current = { range, clips, sections, draftCaptions, selectedId, reviewIndex }
  const takeSnapshot = (): EditSnapshot => ({ ...editorState.current })
  const recordEdit = () => {
    past.current.push(takeSnapshot())
    if (past.current.length > 100) past.current.shift()
    future.current = []
    setHistoryRevision(revision => revision + 1)
  }
  const recordRapidEdit = () => {
    const now = performance.now()
    if (now - captionEditAt.current > 800) recordEdit()
    captionEditAt.current = now
  }
  const applySnapshot = (state: EditSnapshot) => {
    setRange(state.range)
    setClips(state.clips)
    setSections(state.sections)
    setDraftCaptions(state.draftCaptions)
    setSelectedId(state.selectedId)
    setReviewIndex(state.reviewIndex)
  }
  const undoEdit = () => {
    const previous = past.current.pop()
    if (!previous) return
    future.current.push(takeSnapshot())
    applySnapshot(previous)
    setNotice('')
    setEditStatus('Undone.')
    setHistoryRevision(revision => revision + 1)
  }
  const redoEdit = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(takeSnapshot())
    applySnapshot(next)
    setNotice('')
    setEditStatus('Redone.')
    setHistoryRevision(revision => revision + 1)
  }
  const canUndo = past.current.length > 0
  const canRedo = future.current.length > 0

  const activeMusic = effectiveMusic(projectMusic, selectedClip?.music)
  const musicTrack = activeMusic?.track
  const musicKey = musicTrack ? trackKey(musicTrack) : ''
  const musicPath = previewMusic?.key === musicKey ? previewMusic.path : ''
  const canMixPreview = preview !== 'preparing' && preview !== 'unavailable'

  useEffect(() => {
    if (!musicKey || !musicTrack) return
    const cached = musicPaths.current.get(musicKey)
    if (cached) {
      setPreviewMusic({ key: musicKey, path: cached })
      return
    }
    let active = true
    void invoke<string>('open_music', { track: musicTrack }).then(path => {
      if (active) setPreviewMusic({ key: musicKey, path })
    }).catch(error => {
      if (active) setNotice(message(error))
    })
    return () => { active = false }
  }, [musicKey, musicTrack, musicCacheRevision])

  const refreshKainoTrack = (id: string, removed: boolean, collection: KainoCollection = 'music') => {
    const key = kainoKey(id, collection)
    if (removed) {
      musicPaths.current.delete(key)
      setPreviewMusic(current => current?.key === key ? null : current)
    }
    if (musicKey === key) {
      if (!removed) setNotice('')
      setMusicCacheRevision(revision => revision + 1)
    }
  }

  const syncMusic = useCallback((force = false) => {
    const audio = musicPlayer.current
    const player = video.current
    if (!audio || !player) return
    const gain = musicGain(player.currentTime, range.start, range.end, activeMusic?.fade)
    audio.volume = (activeMusic?.volume ?? 0) * previewVolume / 10_000 * gain
    audio.muted = muted
    if (audio.readyState === 0) return
    const target = musicPosition(player.currentTime, range.start, audio.duration, activeMusic?.start)
    const drift = Math.abs(audio.currentTime - target)
    if (force || Math.min(drift, Math.max(0, audio.duration - drift)) > 0.25) audio.currentTime = target
    if (player.paused || player.ended || player.seeking || player.readyState < 3 ||
        player.currentTime < range.start || player.currentTime >= range.end) {
      audio.pause()
    } else if (audio.paused) {
      void audio.play().catch(error => {
        if (error?.name !== 'AbortError') setNotice('Could not play the music preview.')
      })
    }
  }, [activeMusic?.volume, activeMusic?.start, activeMusic?.fade, muted, previewVolume, range.start, range.end])

  useEffect(() => {
    syncMusic()
  }, [syncMusic, musicPath])

  const musicSourceRevision = sourceRequest.current
  const changeMusic = (scope: 'project' | 'clip', music: Music | null | undefined, path?: string) => {
    if (musicSourceRevision !== sourceRequest.current || exportLock.current || importLock.current) return
    recordRapidEdit()
    if (path && music) musicPaths.current.set(trackKey(music.track), path)
    if (scope === 'project') setProjectMusic(music ?? null)
    else if (selectedClip) {
      setClips(items => items.map(clip => clip.id === selectedClip.id ? { ...clip, music } : clip))
    }
  }
  const changeBookend = (scope: 'project' | 'clip', end: keyof Bookends, value: Bookend | null | undefined) => {
    if (musicSourceRevision !== sourceRequest.current || exportLock.current || importLock.current) return
    recordEdit()
    if (scope === 'project') setProjectBookends(previous => ({ ...previous, [end]: value }))
    else if (selectedClip) {
      setClips(items => items.map(clip => clip.id === selectedClip.id
        ? { ...clip, bookends: { ...clip.bookends, [end]: value } } : clip))
    }
  }
  const reviewed = reviewIndex === null ? undefined : sections[reviewIndex]
  const captionKey = selectedClip ? `clip-${selectedClip.id}` : reviewed ? `section-${reviewed.start}-${reviewed.end}` : 'range'
  const currentCaptions = selectedClip ? selectedClip.captions : draftCaptions[captionKey]
  const activeCaptions = useMemo(() => captionSlice(currentCaptions, range), [currentCaptions, range])
  const bookends = useMemo(() => effectiveBookends(projectBookends, selectedClip?.bookends), [projectBookends, selectedClip?.bookends])
  const previewSegments = useMemo(() => selectedClip ? clipSegments(selectedClip) : [{ start: range.start, end: range.end }], [selectedClip, range])
  const sequenceKey = useMemo(() => source && (bookends.intro || bookends.outro)
    ? JSON.stringify([musicSourceRevision, selectedId, previewSegments, format, framing, position, activeCaptions, activeMusic, bookends, musicCacheRevision])
    : '', [source, musicSourceRevision, selectedId, previewSegments, format, framing, position, activeCaptions, activeMusic, bookends, musicCacheRevision])
  const sequence = useSequenceCompositor(sequenceKey, setNotice)
  const stopSequence = sequence.stop
  const sequenceActive = Boolean(sequence.path || sequence.preparing)
  useEffect(() => { useEditor.getState().setSequenceActive(sequenceActive) }, [sequenceActive])
  const playerPlaying = sequence.path ? sequencePlaying : playing
  useEffect(() => {
    if (loading || settingsOpen) stopSequence()
  }, [loading, settingsOpen, stopSequence])
  useEffect(() => {
    if (video.current) video.current.volume = previewVolume / 100
    if (sequence.player.current) sequence.player.current.volume = previewVolume / 100
  }, [previewVolume, previewPath, sequence.path, sequence.player])
  const captionsRunning = captionProgress !== null
  const hasDraftCaptions = Object.values(draftCaptions).some(track => track?.cues.length)

  const hasEdits = Boolean(source && (clips.length || sections.length || projectMusic || projectBookends.intro || projectBookends.outro || hasDraftCaptions ||
    range.start !== 0 || range.end !== source.duration || draftFormat !== 'landscape' ||
    draftQuality !== 'compact' || draftFraming !== 'fill' || Object.values(positions).some(
      position => position.x !== CENTER.x || position.y !== CENTER.y)))

  // Drafts can contain hundreds of thousands of caption characters. Serialize
  // them at most once per burst of edits instead of on every pointer move.
  const draftTimer = useRef<number | null>(null)
  const draftRef = useRef<Draft | null>(null)
  useEffect(() => {
    if (!source) return
    draftRef.current = {
      version: 2, source, range, clips, sections, format: draftFormat, quality: draftQuality,
      framing: draftFraming, positions, captions: draftCaptions, captionStyle: sharedCaptionStyle.current,
      music: projectMusic,
      bookends: projectBookends,
    }
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draftRef.current))
      } catch {
        setNotice('Draft recovery could not save your latest edits.')
      }
    }, 400)
  }, [source, range, clips, sections, draftFormat, draftQuality, draftFraming, positions, draftCaptions, projectMusic, projectBookends])
  useEffect(() => {
    const flush = () => {
      if (draftTimer.current === null || !draftRef.current) return
      window.clearTimeout(draftTimer.current)
      draftTimer.current = null
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draftRef.current))
      } catch {
        // The user is leaving; there is no UI left to report this to.
      }
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    const checkpoint = window.setInterval(flush, 5000)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(checkpoint)
      flush()
    }
  }, [])

  const loadVideo = useCallback(async (path: string, draft?: Draft) => {
    if (exportLock.current || importLock.current) return
    importLock.current = true
    try {
      if (!draft && (recovery || hasEdits) &&
        !await confirm('Opening another video replaces the current recovery draft.', {
        title: 'Replace video?', kind: 'warning', okLabel: 'Replace video',
      })) return
      setLoading(true)
      setNotice('')
      setEditStatus('')
      const info = await invoke<VideoInfo>('open_video', { path, expected: draft?.source })
      ++sourceRequest.current
      stopMomentSearch()
      setMoments([])
      setMomentStatus('')
      setMomentsOpen(false)
      setStyleDockKey(null)
      setMediaDock(current => draft ? null : current)
      playingMoment.current = null
      setRecovery(null)
      if (captionJob.current && !captionJob.current.cancelled) {
        captionJob.current.cancelled = true
        void invoke('cancel_captions').catch(() => {})
      }
      if (video.current) {
        video.current.pause()
        if (video.current.readyState > 0) video.current.currentTime = 0
      }
      setSource(info)
      setPreviewPath(info.path)
      setPreview('direct')
      setPreviewAspect(0)
      setPositions(draft?.positions ?? { landscape: CENTER, portrait: CENTER })
      if (draft) {
        setFormat(draft.format)
        setQuality(draft.quality)
        setFraming(draft.framing)
      }
      setRange(draft?.range ?? { start: 0, end: info.duration })
      setPlaybackTime(0)
      timelinePanned.current = false
      setTimelineZoom(1)
      setTimelineStart(0)
      setPlaying(false)
      setClips(draft?.clips ?? [])
      setProjectMusic(draft?.music ?? null)
      setProjectBookends(draft?.bookends ?? {})
      setClipActions(null)
      nextId.current = Math.max(0, ...(draft?.clips.map(clip => clip.id) ?? [])) + 1
      setSections(draft?.sections ?? [])
      setReviewIndex(null)
      setRenaming(null)
      setRequestedTitle(null)
      setTitleError('')
      titledClips.current.clear()
      frameCache.current.clear()
      setClipFrames({})
      setSelectedId(null)
      setCaptionsOpen(false)
      setCaptionStatus(null)
      setDraftCaptions(draft?.captions ?? {})
      sharedCaptionStyle.current = draft?.captionStyle ?? null
      setFrames({})
      framesRef.current = {}
      framesInFlight.current.clear()
      setExportBatch(null)
      setSplitOpen(false)
    } catch (error) {
      setNotice(message(error))
    } finally {
      importLock.current = false
      setLoading(false)
    }
  }, [recovery, hasEdits, setPlaybackTime])

  const clipStarts = [...new Set(clips.flatMap(clip => clipSegments(clip).map(segment => segment.start)))].join(',')
  useEffect(() => {
    if (!source || !clipStarts) return
    let cancelled = false
    const starts = clipStarts.split(',').map(Number)
    const cache = frameCache.current
    for (const start of cache.keys()) if (!starts.includes(start)) cache.delete(start)
    const pending = starts.filter(start => !cache.has(start))
    if (!pending.length) return
    void invoke<string[]>('clip_thumbnails', { path: source.path, starts: pending })
      .then(images => {
        if (cancelled) return
        pending.forEach((start, index) => cache.set(start, images[index] ?? ''))
        setClipFrames(Object.fromEntries(cache))
      }).catch(() => {})
    return () => { cancelled = true }
  }, [source, clipStarts])

  const chooseVideo = useCallback(async (draft?: Draft) => {
    if (fileDialog.current || exportLock.current || importLock.current) return
    if (!isTauri()) {
      setNotice('Open MiniVidCut as a desktop app to choose a local video.')
      return
    }
    fileDialog.current = true
    try {
      const path = await open({ title: draft ? 'Locate the draft video' : 'Open video', filters: [{ name: 'Video files', extensions: EXTENSIONS }] })
      if (path) await loadVideo(path, draft)
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

  const seek = useCallback((position: number) => {
    if (!source) return
    stopSequence()
    const next = Math.min(duration, Math.max(0, position))
    const player = video.current
    // A timeupdate queued before this seek can arrive afterwards with the old
    // time and pull the playhead back, making it oscillate left and right.
    ignoreTimeUpdateUntil.current = performance.now() + 120
    if (player && player.readyState > 0) player.currentTime = Math.min(next, player.duration)
    setPlaybackTime(next)
  }, [source, duration, stopSequence, setPlaybackTime])

  const refreshCaptionModel = useCallback(async () => {
    const info = await invoke<CaptionModel>('caption_model')
    setCaptionModel(info)
    return info
  }, [])

  const confirmTitleDownload = async (automatic: boolean, hasTranscript = false, searching = false) => {
    const model = await refreshCaptionModel()
    const allowed = localStorage.getItem(TITLE_DOWNLOAD_KEY) === 'yes' || autoTitles
    if (allowed && (model.installed || hasTranscript)) return true
    const accepted = await confirm(
      `${searching ? 'Search this transcript on this device?' : 'Generate editable titles on this device?'}${allowed ? '' : ' First use downloads the 229 MB language model and 25 MB runtime.'}${
        model.installed || hasTranscript ? '' : ` Clips without captions also need the ${Math.round(model.bytes / 1_000_000)} MB speech model.`
      }`,
      { title: searching ? 'Find moments with AI' : automatic ? 'Enable automatic clip titles?' : 'Generate a clip title?', okLabel: searching ? 'Search' : automatic ? 'Enable' : 'Generate' },
    )
    if (accepted) localStorage.setItem(TITLE_DOWNLOAD_KEY, 'yes')
    return accepted
  }

  const toggleAutoTitles = async () => {
    if (autoTitles) {
      setAutoTitles(false)
      localStorage.removeItem(AUTO_TITLES_KEY)
      return
    }
    try {
      if (!await confirmTitleDownload(true)) return
      titledClips.current.clear()
      setTitleError('')
      localStorage.setItem(AUTO_TITLES_KEY, 'on')
      setAutoTitles(true)
    } catch (error) {
      setTitleError(message(error))
    }
  }

  const titleClip = async (clip: Clip) => {
    const sourceRevision = sourceRequest.current
    try {
      if (!await confirmTitleDownload(false, Boolean(clip.captions?.cues.some(cue => cue.text.trim())))) return
      if (sourceRevision !== sourceRequest.current) return
      setTitleError('')
      setRequestedTitle({ id: clip.id, sourceRevision })
    } catch (error) {
      setTitleError(message(error))
    }
  }

  useEffect(() => {
    if (settingsOpen || !source || (!autoTitles && !requestedTitle) || !isTauri() || loading || busy || captionsRunning ||
      titleJob.current || captionJob.current || momentJob.current || importLock.current || exportLock.current || titleError) return
    const revision = sourceRequest.current
    const clip = requestedTitle
      ? clips.find(clip => requestedTitle.sourceRevision === revision && clip.id === requestedTitle.id)
      : clips.find(clip => !clip.title && !clip.titleManuallyEdited && clip.id !== renaming &&
        !titledClips.current.has(`${revision}:${clip.id}:${clip.start}:${clip.end}`))
    if (requestedTitle) setRequestedTitle(null)
    if (!clip) return
    const key = `${revision}:${clip.id}:${clip.start}:${clip.end}`
    titledClips.current.add(key)
    titleJob.current = true
    const stale = () => revision !== sourceRequest.current || (!requestedTitle && localStorage.getItem(AUTO_TITLES_KEY) !== 'on')
    const generate = async () => {
      setTitleProgress('Preparing clip title…')
      let transcript = clip.captions?.cues.map(cue => cue.text).join(' ').trim()
      if (!transcript) {
        setTitleProgress('Transcribing clip for its title…')
        const progress = new Channel<CaptionProgress>()
        progress.onmessage = update => {
          if (!stale() && update.stage === 'downloading') {
            setTitleProgress(`Downloading speech model… ${Math.round(update.fraction * 100)}%`)
          }
        }
        const cues = await invoke<CaptionCue[]>('generate_captions', {
          request: { path: source.path, range: { start: clip.start, end: clip.end }, duration: source.duration, allowDownload: true },
          progress,
        })
        transcript = cues.map(cue => cue.text).join(' ').trim()
      }
      if (stale()) return
      if (!transcript) {
        if (requestedTitle) setNotice('No speech detected in this clip.')
        return
      }
      const progress = new Channel<string>()
      progress.onmessage = status => { if (!stale()) setTitleProgress(status) }
      const title = await invoke<string>('generate_title', { transcript, progress })
      if (stale()) return
      setClips(items => items.map(item =>
        item.id === clip.id && item.start === clip.start && item.end === clip.end &&
        item.title === clip.title && item.titleManuallyEdited === clip.titleManuallyEdited
        ? { ...item, title, titleManuallyEdited: undefined } : item))
    }
    void generate().catch(error => {
      const text = message(error)
      if (stale()) return
      if (requestedTitle) {
        setNotice(text)
      } else if (text !== 'This video has no audio track to caption.') {
        setTitleError(`Automatic titles paused. ${text}`)
      }
    }).finally(() => {
      titleJob.current = false
      setTitleProgress('')
      if (!stale()) void refreshCaptionModel().catch(() => {})
    })
  }, [autoTitles, busy, captionsRunning, clips, loading, momentRunning, renaming, requestedTitle, settingsOpen, source, titleError, titleProgress, refreshCaptionModel])

  const openCaptions = (key = captionKey) => {
    setRenaming(null)
    setCaptionsOpen(true)
    void refreshCaptionModel().catch(error => setCaptionStatus({ key, text: message(error) }))
  }

  const closeCaptions = useCallback(() => {
    setCaptionsOpen(false)
    clipsTab.current?.focus()
  }, [])

  const saveCaptions = useCallback((track: CaptionTrack) => {
    recordRapidEdit()
    if (selectedId === null) setDraftCaptions(current => ({ ...current, [captionKey]: track }))
    else setClips(items => items.map(clip => clip.id === selectedId ? { ...clip, captions: track } : clip))
    setCaptionStatus(current => current?.key === captionKey ? null : current)
  }, [selectedId, captionKey])

  const saveCaptionStyle = useCallback((style: CaptionStyle) => {
    if (currentCaptions) saveCaptions({ ...currentCaptions, style })
  }, [currentCaptions, saveCaptions])

  const applyCaptionStyle = useCallback((style: CaptionStyle) => {
    if (exportLock.current || importLock.current || captionJob.current) return false
    recordEdit()
    sharedCaptionStyle.current = style
    setClips(items => items.map(clip => restyleCaptionedClip(clip, style)))
    setDraftCaptions(items => Object.fromEntries(Object.entries(items).map(([key, track]) =>
      [key, track && { ...track, style }])))
    return true
  }, [])

  const runCaptionJob = async (targets: { key: string; range: Range; clip?: Clip; track?: CaptionTrack }[], action: 'editor' | 'clip' | 'stack') => {
    if (!source || !targets.length || titleJob.current || captionJob.current || momentJob.current?.transcribing || exportLock.current || importLock.current || fileDialog.current) return
    if (!targets.every(target => validRange(target.range, duration))) return
    const job = { keys: new Set(targets.map(target => target.key)), cancelled: false }
    captionJob.current = job
    const request = sourceRequest.current
    const batch = action === 'stack'
    const statusKey = batch ? 'batch' : targets[0].key
    const stale = () => job.cancelled || request !== sourceRequest.current
    let saved = 0
    let empty = 0
    let noAudio = false
    const failures: string[] = []
    try {
      const model = captionModel ?? await refreshCaptionModel()
      if (stale()) return
      if (action !== 'editor' && !model.installed && !await confirm(
        `Download the ${Math.round(model.bytes / 1_000_000)} MB speech model to generate captions on this device?`,
        { title: 'Download caption model?', okLabel: 'Download & generate' },
      )) return
      if (action === 'editor' && targets[0].track?.cues.some(cue => cue.text.trim()) &&
        !await confirm('Generate a new transcript and replace the captions for this shot?', {
          title: 'Regenerate captions?', okLabel: 'Regenerate',
        })) return
      if (stale()) return
      setCaptionStatus(null)
      for (const [index, target] of targets.entries()) {
        if (stale()) break
        const position = { index, total: targets.length }
        setCaptionProgress({ stage: 'starting', ...position })
        const progress = new Channel<CaptionProgress>()
        progress.onmessage = update => {
          if (captionJob.current === job && !stale()) setCaptionProgress({ ...update, ...position })
        }
        try {
          const { start, end } = target.range
          const cues = await invoke<CaptionCue[]>('generate_captions', {
            request: { path: source.path, range: { start, end }, duration: source.duration, allowDownload: !model.installed },
            progress,
          })
          if (stale()) break
          if (!cues.length) { empty++; continue }
          const track: CaptionTrack = {
            style: target.track?.style ?? sharedCaptionStyle.current ?? { ...DEFAULT_CAPTION_STYLE, mode: 'highlight', font: 'Segoe UI' },
            cues: cues.map(cue => offsetCaption(cue, start)),
          }
          if (target.clip) {
            setClips(items => items.map(clip => clip.id === target.clip?.id ? { ...clip, captions: track } : clip))
          } else {
            setDraftCaptions(items => ({ ...items, [target.key]: track }))
          }
          saved++
        } catch (error) {
          if (stale()) break
          if (message(error) === 'This video has no audio track to caption.') {
            noAudio = true
            empty += targets.length - index
            break
          }
          failures.push(message(error))
          if (!model.installed && !await refreshCaptionModel().then(info => info.installed).catch(() => false)) break
        }
      }
      if (request !== sourceRequest.current) return
      if (batch) {
        const details = [`${saved} captioned`, empty ? `${empty} with no speech` : '', failures.length ? `${failures.length} failed` : '',
          job.cancelled ? 'Canceled' : saved + empty + failures.length < targets.length ? 'Batch stopped' : ''].filter(Boolean)
        setCaptionStatus({ key: statusKey, text: details.join(' · ') + (failures.length ? `. ${failures[0]}` : '') })
      } else if (failures.length || empty) {
        setCaptionStatus({ key: statusKey, text: failures[0] ?? (noAudio ? 'This video has no audio track to caption.' : 'No speech detected in this clip.') })
      }
    } catch (error) {
      if (!stale()) setCaptionStatus({ key: statusKey, text: message(error) })
    } finally {
      captionJob.current = null
      setCaptionProgress(null)
      if (request === sourceRequest.current) void refreshCaptionModel().catch(() => {})
    }
  }

  const generateCaptions = () => void runCaptionJob([{ key: captionKey, range, clip: selectedClip, track: activeCaptions }], 'editor')

  const cancelCaptions = useCallback(() => {
    const job = captionJob.current
    if (!job) return
    job.cancelled = true
    setCaptionProgress(current => current && { stage: 'canceling', index: current.index, total: current.total })
    void invoke('cancel_captions').catch(() => {})
  }, [])

  const captionSeek = useCallback((position: number) => {
    video.current?.pause()
    seek(position)
  }, [seek])

  const captionPlayhead = useCallback(() => video.current?.currentTime ?? range.start, [range.start])

  const playSequence = () => {
    if (!source || !validRange(range, duration) || !sequenceKey) return
    video.current?.pause()
    musicPlayer.current?.pause()
    setNotice('')
    void sequence.play({
      path: source.path, range, segments: previewSegments, captions: currentCaptions, music: activeMusic,
      musicPath, muted, bookends, options: { format, framing, position },
    })
  }

  const toggleSequence = () => {
    if (sequence.preparing) {
      stopSequence()
      return
    }
    const player = sequence.player.current
    if (!player) return
    if (player.paused) void player.play().catch(error => setNotice(message(error)))
    else player.pause()
  }

  const togglePlay = () => {
    if (sequenceActive) {
      toggleSequence()
      return
    }
    if (sequenceKey && validRange(range, duration) && !loading) {
      playSequence()
      return
    }
    const player = video.current
    if (!player || !source || loading) return
    if (!player.paused) {
      player.pause()
      return
    }
    const from = player.currentTime
    const saved = selectedId === 0 ? exportBatch?.ranges.find(clip => clip.id === 0) : clips.find(clip => clip.id === selectedId)
    const reviewed = reviewIndex === null ? undefined : sections[reviewIndex]
    const previewed = saved ?? reviewed ?? playingMoment.current
    const playingSection = previewed?.start === range.start && previewed.end === range.end

    if (player.ended || (playingSection && from >= range.end - 0.005) || (!playingSection && from >= duration - 0.005)) {
      seek(playingSection ? range.start : 0)
    } else if (playingSection && from < range.start) {
      seek(range.start)
    }

    playUntil.current = playingSection ? range.end : null
    void player.play().catch(error => {
      if (error?.name !== 'AbortError') setNotice(message(error))
    })
  }

  const playMusicMix = () => {
    if (sequenceActive || sequenceKey) {
      togglePlay()
      return
    }
    const player = video.current
    if (!player) return
    if (!player.paused) {
      player.pause()
      return
    }
    if (player.currentTime < range.start || player.currentTime >= range.end - 0.005) seek(range.start)
    playUntil.current = range.end
    void player.play().catch(error => {
      if (error?.name !== 'AbortError') setNotice(message(error))
    })
  }

  const seekPlayback = (offset: number) => {
    const player = sequence.player.current
    if (player && player.readyState > 0) {
      player.seek(player.currentTime + offset)
    } else if (!sequence.preparing) seek(playbackClock.get() + offset)
  }

  function stopMomentSearch() {
    const job = momentJob.current
    if (!job || job.canceled) return
    job.canceled = true
    setMomentStopping(true)
    setMomentStatus('Stopping Smart Split…')
    if (job.transcribing) void invoke('cancel_captions').catch(() => {})
  }

  const searchMoments = async (request: string, maximum: number, maxResults: number) => {
    if (!source || momentJob.current || captionJob.current || titleJob.current || importLock.current) return
    const limit = momentLimit(request, maximum)
    if (!Number.isFinite(limit) || limit < 0.05 || limit > 120 ||
      !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_CLIPS) {
      setMomentStatus('Choose a valid clip length and number of suggestions.')
      return
    }
    const revision = sourceRequest.current
    const job = { canceled: false, transcribing: false }
    momentJob.current = job
    setMomentRunning(true)
    setMomentProgress(null)
    setMomentStatus('Getting ready to find clips…')
    const current = () => sourceRequest.current === revision
    const active = () => current() && !job.canceled
    const videoRange = { start: 0, end: source.duration }
    if (momentCache.current.revision !== revision) {
      momentCache.current = { revision, batches: [], matches: new Map() }
    }
    const { batches: cache, matches } = momentCache.current
    const known: typeof cache = []
    const addKnown = (range: Range, track?: CaptionTrack) => {
      if (!track?.cues.some(cue => cue.text.trim())) return
      // Edited captions can cover only part of a clip. Scan the rest for speech.
      for (const cue of track.cues) {
        if (cue.text.trim() && cue.start >= range.start && cue.end <= range.end) {
          known.push({ range: cue, cues: [cue] })
        }
      }
    }
    for (const clip of clips) addKnown(clip, clip.captions)
    addKnown(videoRange, draftCaptions.range)
    for (const section of sections) addKnown(section, draftCaptions[`section-${section.start}-${section.end}`])
    let count = 0
    try {
      if (!active()) return
      const missing = missingTranscriptRanges(videoRange, [...known, ...cache].map(batch => batch.range))
      if (!await confirmTitleDownload(false, !missing.length, true)) return
      if (!active()) return
      setMoments([])
      for (let start = 0; start < source.duration && active() && count < maxResults; start += MOMENT_BATCH_SECONDS) {
        const batch = { start, end: Math.min(start + MOMENT_BATCH_SECONDS, source.duration) }
        const status = () => `Searching ${stamp(batch.start)}–${stamp(batch.end)} · ${count} of ${maxResults} found`
        setMomentStatus(status())
        setMomentProgress(start / source.duration)
        const cues = known.filter(item => item.range.start >= batch.start && item.range.start < batch.end).flatMap(item => item.cues)
        const includeGenerated = (generated: CaptionCue[]) => {
          const existing = cues.slice()
          cues.push(...generated.filter(cue => !existing.some(saved => rangesOverlap(saved, cue))))
        }
        for (const cached of cache) {
          if (rangesOverlap(cached.range, batch)) includeGenerated(cached.cues.filter(cue => cue.start >= batch.start && cue.start < batch.end))
        }
        const gaps = missing.filter(gap => rangesOverlap(gap, batch)).map(gap => ({
          start: Math.max(gap.start, batch.start), end: Math.min(gap.end, batch.end),
        })).filter(gap => gap.end - gap.start >= 0.05)
        for (const gap of gaps) {
          while (active() && captionJob.current) await new Promise(resolve => setTimeout(resolve, 100))
          if (!active()) break
          job.transcribing = true
          setMomentStatus('Listening for moments in this part of the video…')
          try {
            const progress = new Channel<CaptionProgress>()
            progress.onmessage = update => {
              if (!active()) return
              if (update.stage === 'downloading') setMomentStatus(`Downloading speech tools · ${Math.round(update.fraction * 100)}%`)
              else if (update.stage === 'transcribing') {
                setMomentStatus('Listening for moments in this part of the video…')
                const scanned = gap.start - batch.start + (gap.end - gap.start) * update.fraction
                setMomentProgress(previous => Math.max(previous ?? 0, (batch.start + scanned * 0.8) / source.duration))
              }
            }
            const result = await invoke<CaptionCue[]>('generate_captions', {
              request: { path: source.path, range: gap, duration: source.duration, allowDownload: true }, progress,
            })
            const generated = result.map(cue => offsetCaption(cue, gap.start))
            cache.push({ range: gap, cues: generated })
            includeGenerated(generated)
          } finally {
            job.transcribing = false
          }
        }
        if (!active()) break
        setMomentStatus(status())
        const unique = [...new Map(cues.map(cue => [`${cue.start}:${cue.end}`, cue])).values()].sort((a, b) => a.start - b.start)
        const candidates = momentCandidates(unique, { ...batch, end: Math.min(source.duration, batch.end + limit) }, limit)
        for (let index = 0; index < candidates.length && active() && count < maxResults; index += 4) {
          const group = candidates.slice(index, index + 4)
          const excerpts = group.map(item => item.text)
          const key = JSON.stringify([request, excerpts])
          let match = matches.get(key)
          if (match === undefined) {
            const progress = new Channel<string>()
            progress.onmessage = () => { if (active()) setMomentStatus('Preparing Smart Split for first use…') }
            match = await invoke<number | null>('select_moment', { request, excerpts, progress })
            if (matches.size >= 500) matches.clear()
            matches.set(key, match)
          }
          if (active() && match !== null && group[match]) {
            count++
            setMoments(items => [...items, group[match]])
          }
          if (active()) {
            setMomentStatus(status())
            setMomentProgress((batch.start + (batch.end - batch.start) * (0.8 + 0.2 * Math.min(1, (index + 4) / candidates.length))) / source.duration)
          }
        }
      }
      if (active()) setMomentStatus(count ? `Review ${count} suggested ${count === 1 ? 'moment' : 'moments'}.` : 'No matching moments found.')
    } catch (error) {
      if (active()) setMomentStatus(message(error) === 'This video has no audio track to caption.'
        ? 'This video has no audio to search.' : 'Smart Split couldn’t finish. You can retry or review the suggestions already found.')
    } finally {
      if (current() && job.canceled) setMomentStatus('Search stopped. Suggestions found so far are kept.')
      momentJob.current = null
      setMomentRunning(false)
      setMomentStopping(false)
      setMomentProgress(null)
      if (current()) void refreshCaptionModel().catch(() => {})
    }
  }

  const previewMoment = (moment: Moment) => {
    const player = video.current
    playingMoment.current = moment
    setSelectedId(null)
    setReviewIndex(null)
    setRange(moment)
    revealTimelineTime(moment.start)
    seek(moment.start)
    playUntil.current = moment.end
    if (player) void player.play().catch(error => {
      if (error?.name !== 'AbortError') setNotice(message(error))
    })
  }

  const addMoment = (moment: Moment) => {
    if (exportLock.current || importLock.current || clips.length >= MAX_CLIPS) return
    const id = nextId.current++
    const style = sharedCaptionStyle.current ?? DEFAULT_CAPTION_STYLE
    recordEdit()
    setClips(items => items.length >= MAX_CLIPS || items.some(clip => clip.start === moment.start && clip.end === moment.end)
      ? items : [...items, { id, start: moment.start, end: moment.end, segments: [{ start: moment.start, end: moment.end }], captions: { style, cues: moment.cues } }])
  }

  const editBoundary = (side: keyof Range, value: number, original = range) => {
    if (selectedLocked) return false
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
    if (selectedLocked) return
    if (!validRange(range, duration)) return
    if (captionJob.current?.keys.has(captionKey)) return
    if (selectedId !== null) {
      recordEdit()
      setClips(items => items.map(clip => clip.id === selectedId ? {
        ...clip, start: range.start, end: range.end, segments: [{ ...range }], captions: captionSlice(clip.captions, range),
      } : clip))
      setSelectedId(null)
      return
    }
    if (clips.length >= MAX_CLIPS) {
      setNotice(`A batch can contain up to ${MAX_CLIPS} clips.`)
      return
    }
    recordEdit()
    const clip = { start: range.start, end: range.end, segments: [{ ...range }], id: nextId.current++, captions: activeCaptions }
    setClips(items => [...items, clip])
    if (activeCaptions) {
      if (reviewIndex === null) setDraftCaptions(current => ({ ...current, [captionKey]: undefined }))
      setSelectedId(clip.id)
      setReviewIndex(null)
    }
    setNotice('')
  }

  const reviewSection = (parts: Range[], index: number) => {
    const section = parts[index]
    if (!section) return
    video.current?.pause()
    setRange(section)
    setSelectedId(null)
    setReviewIndex(index)
    revealTimelineTime(section.start)
    seek(section.start)
  }

  const splitParts = (parts: Range[] | null, selectLast = false) => {
    if (selectedLocked) return
    setSplitOpen(false)
    if (captionJob.current?.keys.has(captionKey)) return
    if (!parts || parts.length < 2) {
      setNotice(parts ? 'Choose an interval shorter than the trim range.' : 'Choose a longer interval to create at most 100 sections.')
      return
    }
    recordEdit()
    if (splitMode === 'mark') {
      if (activeCaptions) setDraftCaptions(current => ({
        ...current,
        ...Object.fromEntries(parts.map(part => [`section-${part.start}-${part.end}`, captionSlice(activeCaptions, part)])),
      }))
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
      const original = clips[replaced]
      const title = original?.title
      return { ...part, segments: [{ ...part }], id: nextId.current++, title: title ? `${title} - Part ${index + 1}` : undefined,
        captions: captionSlice(activeCaptions, part), music: original?.music, bookends: original?.bookends }
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
    const at = activeTime()
    const first = { start: range.start, end: at }
    const second = { start: at, end: range.end }
    if (!validRange(first, duration) || !validRange(second, duration)) {
      setNotice('Move the playhead inside the trim range before splitting.')
      return
    }
    splitParts([first, second], true)
  }

  const selectClip = (clip: Clip) => {
    playingMoment.current = null
    setClipActions(null)
    video.current?.pause()
    setRange({ start: clip.start, end: clip.end })
    setSelectedId(clip.id)
    setReviewIndex(null)
    revealTimelineTime(clip.start)
    seek(clip.start)
  }

  const captionClip = (clip: Clip) => {
    selectClip(clip)
    openCaptions(`clip-${clip.id}`)
    captionsTab.current?.focus()
    if (clipsNeedingCaptions([clip]).length) {
      void runCaptionJob([{ key: `clip-${clip.id}`, range: clip, clip, track: clip.captions }], 'clip')
    }
  }

  const captionStack = () => {
    const missing = clipsNeedingCaptions(clips)
    if (!missing.length) return
    selectClip(missing[0])
    openCaptions(`clip-${missing[0].id}`)
    captionsTab.current?.focus()
    void runCaptionJob(missing.map(clip => ({ key: `clip-${clip.id}`, range: clip, clip, track: clip.captions })), 'stack')
  }

  const trimSection = () => {
    if (!canTrim) return

    // With saved clips, the In–Out cut applies to the whole timeline, not just
    // whichever clip happens to be selected (see trimClips in clip.ts).
    if (!sections.length && clips.length) {
      const trimmed = trimClips(clips, range, duration, track => captionCut(track, range))
      if (trimmed.length > MAX_CLIPS) {
        setNotice(`Keep at most ${MAX_CLIPS} clips.`)
        return
      }
      recordEdit()
      const previousIndex = clips.findIndex(clip => clip.id === selectedId)
      setClips(trimmed)
      const next = trimmed.find(clip => clip.id === selectedId)
        ?? trimmed[Math.min(Math.max(previousIndex, 0), trimmed.length - 1)]
      if (next) selectClip(next)
      else {
        video.current?.pause()
        setSelectedId(null)
        setReviewIndex(null)
        setRange({ start: range.start, end: range.start })
        seek(range.start)
      }
      setNotice('')
      setEditStatus(trimmed.length < clips.length
        ? `Cut removed from all clips. ${trimmed.length} ${trimmed.length === 1 ? 'clip' : 'clips'} kept.`
        : 'Cut removed from the clips on the timeline.')
      return
    }

    const draftTargets = sections.length ? sections : [{ start: 0, end: duration }]
    const parts = draftTargets.flatMap(section => cutRange(section, range))
    const remaining = parts
    if (remaining.length > MAX_CLIPS) {
      setNotice(`Keep at most ${MAX_CLIPS} marked sections.`)
      return
    }
    recordEdit()

    setDraftCaptions(current => {
      const updated = { ...current }
      for (const key of Object.keys(updated)) if (key.startsWith('section-')) delete updated[key]
      for (const section of draftTargets) {
        const track = sections.length ? current[`section-${section.start}-${section.end}`] : current.range
        for (const part of cutRange(section, range)) {
          if (track) updated[`section-${part.start}-${part.end}`] = captionSlice(track, part)
        }
      }
      return updated
    })

    setSections(remaining)
    if (remaining.length) {
      const preferred = parts.find(section => section.start >= range.end) ?? parts.at(-1)
      const next = preferred ? remaining.findIndex(section => section.start === preferred.start && section.end === preferred.end) : -1
      reviewSection(remaining, next < 0 ? remaining.length - 1 : next)
    } else {
      setSelectedId(null)
      setReviewIndex(null)
      setRange({ start: range.start, end: range.start })
      video.current?.pause()
    }
    setNotice('')
    setEditStatus('Cut removed from the marked ranges.')
  }

  const renameClip = (id: number, title: string) => {
    if (clipLocked(id)) return
    const cleaned = title.trim()
    recordEdit()
    setClips(items => items.map(clip => clip.id === id
      ? { ...clip, title: cleaned || undefined, titleManuallyEdited: true } : clip))
    setRenaming(null)
  }

  const splitClip = () => {
    if (!selectedClip || selectedLocked || busy) return
    const at = playbackClock.get()
    const next = splitClipAt(selectedClip, at, duration)
    if (!next) {
      setNotice('Move the playhead inside the clip before adding a cut.')
      return
    }
    recordEdit()
    setClips(items => items.map(clip => clip.id === next.id ? next : clip))
    setRange({ start: next.start, end: next.end })
    setNotice('')
    setEditStatus('Cut added inside the clip. Both parts stay in this clip.')
  }

  const deleteClip = () => {
    if (!selectedClip || selectedLocked || busy) return
    recordEdit()
    setClips(items => items.filter(clip => clip.id !== selectedClip.id))
    setSelectedId(null)
    setReviewIndex(null)
    setRange({ start: 0, end: duration })
    setNotice('')
    setEditStatus('Clip removed. The following clips fill its place in the export.')
  }

  const startClipEdgeDrag = (event: ReactPointerEvent, clip: Clip, side: 'start' | 'end') => {
    if (!source || loading || selectedLocked || busy || event.button !== 0 || !track.current) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    const rect = track.current.getBoundingClientRect()
    const pointer = toSource(timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width))
    clipEdgeDrag.current = { clip, side, axisPointer: timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width),
      value: clip[side], recorded: false }
    seek(clip[side])
  }

  const moveClipEdgeDrag = (event: ReactPointerEvent) => {
    const drag = clipEdgeDrag.current
    if (!drag || busy || !track.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = track.current.getBoundingClientRect()
    const axis = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width)
    const raw = drag.value + axis - drag.axisPointer
    const value = Math.max(0, Math.min(duration, snap(raw)))
    const next = resizeClipEdge(drag.clip, drag.side, value, duration)
    if (!next) return
    if (!drag.recorded) {
      recordEdit()
      drag.recorded = true
    }
    const updated = { ...next, captions: captionSlice(next.captions, next) }
    setClips(items => items.map(clip => clip.id === next.id ? updated : clip))
    setRange({ start: next.start, end: next.end })
    seek(value)
  }

  const startClipReorder = (event: ReactPointerEvent, index: number) => {
    if (timelineView !== 'sequence' || disabled || busy || event.button !== 0 || !track.current) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    clipReorder.current = { index, x: event.clientX, moved: false }
  }

  const moveClipReorder = (event: ReactPointerEvent) => {
    const drag = clipReorder.current
    if (!drag || !track.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    if (Math.abs(event.clientX - drag.x) < 5) return
    drag.moved = true
    reorderMoved.current = true
    const rect = track.current.getBoundingClientRect()
    const axis = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width)
    let target = 0
    let best = Infinity
    sequenceSpans.forEach((span, index) => {
      const distance = Math.abs((span.start + span.end) / 2 - axis)
      if (distance < best) { best = distance; target = index }
    })
    reorderTargetRef.current = target
    setReorderTarget(target)
  }

  const finishClipReorder = () => {
    const drag = clipReorder.current
    clipReorder.current = null
    const target = reorderTargetRef.current
    reorderTargetRef.current = null
    setReorderTarget(null)
    if (!drag?.moved || target === null || target === drag.index) return
    recordEdit()
    setClips(items => reorderClips(items, drag.index, target))
  }

  const exportVideos = async (only?: Clip) => {
    if (!source || exportLock.current || importLock.current || fileDialog.current || captionJob.current || titleJob.current) return
    if (!clips.length && sections.length) return
    const batch: Clip[] = only ? [only] : clips.length ? clips : [{ ...range, id: 0, captions: activeCaptions }]
    const options = { format: draftFormat, framing: draftFraming, position: positions[draftFormat], quality: draftQuality }
    if (!batch.every(clip => validRange(clip, duration))) return
    exportLock.current = true
    setNotice('')
    setEditStatus('')
    cancelRequested.current = false
    exportReady.current = null
    const request = ++exportRequest.current
    let started = false
    const overlays: string[] = []
    try {
      const folder = await open({ directory: true, title: 'Choose where to save your clips' })
      if (!folder) return
      started = true
      setCaptionsOpen(false)
      // Each source segment becomes one FFmpeg file, but the UI keeps one
      // status and one lock per clip (see groupExportStates).
      const units = exportUnits(batch)
      const owners: number[] = []
      batch.forEach((clip, index) => {
        for (const _segment of clipSegments(clip)) owners.push(index)
      })
      // summarizeExport pairs one weight with one displayed clip status.
      const weights: Range[] = batch.map(clip => ({ start: 0,
        end: clipSegments(clip).reduce((total, segment) => total + segment.end - segment.start, 0) }))
      let unitStates: ExportState[] = owners.map(() => ({ status: 'queued' }))
      const syncStates = () => setExportBatch(current => current && {
        ...current, states: groupExportStates(unitStates, owners, batch.length),
      })
      setExportBatch({ ranges: batch, states: batch.map(() => ({ status: 'queued' })), weights, running: true, options })
      const hasCaptionArtwork = batch.some(clip => clip.captions?.cues.some(cue => cue.text.trim()))
      if (hasCaptionArtwork) setNotice('Preparing caption artwork…')
      const jobId = crypto.randomUUID()
      const channel = new Channel<ExportProgress | null>()
      channel.onmessage = event => {
        if (request !== exportRequest.current || !exportLock.current) return
        if (event === null) {
          exportReady.current = jobId
          if (cancelRequested.current) void sendExportCancellation(jobId)
          return
        }
        const { index, ...state } = event
        if (index < 0 || index >= unitStates.length) return
        const previous = unitStates[index]
        if (previous.status === 'saved' || previous.status === 'failed' || previous.status === 'canceled') return
        if (state.status === 'encoding' && previous.status === 'encoding' && previous.fraction >= state.fraction) return
        unitStates[index] = state
        syncStates()
      }
      const prepared: {
        start: number; end: number; title?: string; captionOverlay?: string
        music: (Music & { start?: number }) | null; bookends: Bookends
      }[] = []
      const musicOffsets = new Map<number, number>()
      const OVERLAY_CONCURRENCY = 3
      for (let index = 0; index < units.length; index += OVERLAY_CONCURRENCY) {
        if (cancelRequested.current) break
        const chunk = units.slice(index, index + OVERLAY_CONCURRENCY)
        const rendered = await Promise.all(chunk.map(async unit => {
          const captions = captionSlice(unit.clip.captions, unit.segment, true)
          const captionOverlay = captions && await prepareCaptionOverlay(captions, options.format,
            unit.segment.end - unit.segment.start, () => cancelRequested.current)
          return captionOverlay || undefined
        }))
        rendered.forEach((captionOverlay, offset) => {
          const unit = chunk[offset]
          if (captionOverlay) overlays.push(captionOverlay)
          const ends = effectiveBookends(projectBookends, unit.clip.bookends)
          const musicOffset = musicOffsets.get(unit.clip.id) ?? 0
          musicOffsets.set(unit.clip.id, musicOffset + unit.segment.end - unit.segment.start)
          const music = effectiveMusic(projectMusic, unit.clip.music)
          prepared.push({
            start: unit.segment.start, end: unit.segment.end,
            title: unit.first ? unit.clip.title : undefined,
            captionOverlay,
            music: music ? { ...music, start: musicOffset + (music.start ?? 0) } : null,
            bookends: {
              intro: unit.first ? ends.intro : null,
              outro: unit.last ? ends.outro : null,
            },
          })
        })
      }
      if (hasCaptionArtwork) setNotice('')
      const rawStates = cancelRequested.current
        ? units.map(() => ({ status: 'canceled' as const }))
        : await invoke<ExportState[]>('export_clips', {
          path: source.path, folder, clips: prepared,
          options, progress: channel, jobId, duration: source.duration,
        })
      unitStates = rawStates
      const states = groupExportStates(rawStates, owners, batch.length)
      setExportBatch({ ranges: batch, states, weights, running: false, options })
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
      if (overlays.length) void invoke('discard_caption_overlays', { ids: overlays }).catch(() => {})
      if (started) setSelectedId(current => current === 0 ? null : current)
      exportReady.current = null
      setCancelingExport(false)
      exportLock.current = false
    }
  }

  const sendExportCancellation = async (jobId: string) => {
    try {
      await invoke('cancel_export', { jobId })
    } catch (error) {
      setNotice(message(error))
      setCancelingExport(false)
    }
  }

  const cancelExport = () => {
    cancelRequested.current = true
    setCancelingExport(true)
    if (exportReady.current) void sendExportCancellation(exportReady.current)
  }

  // State used by the global shortcuts is read through a ref so the listeners
  // are attached once instead of being replaced on every render.
  const shortcutState = useRef({
    captionsOpen, settingsOpen, shortcuts, source, loading, timelineZoom,
    closeCaptions, chooseVideo, zoomTimelineTo, editBoundary, seekPlayback, addClip, togglePlay,
    undoEdit, redoEdit, splitClip, deleteClip,
  })
  shortcutState.current = {
    captionsOpen, settingsOpen, shortcuts, source, loading, timelineZoom,
    closeCaptions, chooseVideo, zoomTimelineTo, editBoundary, seekPlayback, addClip, togglePlay,
    undoEdit, redoEdit, splitClip, deleteClip,
  }
  useEffect(() => {
    const isTextEditing = (el: Element | null): boolean => {
      if (!el) return false
      if (el.closest('textarea, [contenteditable="true"], [contenteditable=""]')) return true
      const input = el.closest('input')
      if (input) {
        const nonText = ['range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file']
        return !nonText.includes(input.type.toLowerCase())
      }
      return false
    }

    const shortcutsHandler = (event: KeyboardEvent) => {
      const state = shortcutState.current
      if (document.querySelector('.settings-page:not([hidden])')) return
      const key = event.key.toLowerCase()
      const target = event.target instanceof Element ? event.target : null

      if (event.key === 'Escape') {
        if (state.captionsOpen && target?.closest('#caption-editor') && !target.closest('input, select, textarea')) state.closeCaptions()
        setShortcuts(false)
        setSplitOpen(false)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'o') {
        event.preventDefault()
        void state.chooseVideo()
        return
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === '+' || key === '=' || event.code === 'NumpadAdd') {
          event.preventDefault()
          if (state.source && !state.loading) state.zoomTimelineTo(state.timelineZoom * 2)
          return
        }
        if (key === '-' || key === '_' || event.code === 'NumpadSubtract') {
          event.preventDefault()
          if (state.source && !state.loading) state.zoomTimelineTo(state.timelineZoom / 2)
          return
        }
        if (key === '0' || event.code === 'Numpad0') {
          event.preventDefault()
          if (state.source && !state.loading) state.zoomTimelineTo(1)
          return
        }
        if (key === 'z' || key === 'y') {
          if (isTextEditing(target)) return
          event.preventDefault()
          if (key === 'y' || event.shiftKey) state.redoEdit()
          else state.undoEdit()
          return
        }
      }

      if (state.shortcuts) return

      if (isTextEditing(target) || event.ctrlKey || event.metaKey || event.altKey || !state.source || state.loading) return
      if (key === 'i' || key === 'o') {
        state.editBoundary(key === 'i' ? 'start' : 'end', activeTime())
        return
      }
      if (key === 'arrowleft' || key === 'arrowright') {
        if (!target?.closest('input[type="range"]')) {
          event.preventDefault()
          state.seekPlayback((key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 5 : 1))
        }
        return
      }
      if (key === 'enter' && !event.repeat) {
        if (!target?.closest('button, a, input, select, textarea')) state.addClip()
      }
      if (key === 's' && !event.repeat && !target?.closest('button, a, input, select, textarea')) {
        state.splitClip()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!target?.closest('button, a, input, select, textarea')) {
          event.preventDefault()
          if (!event.repeat) state.deleteClip()
        }
      }
    }
    const playbackShortcut = (event: KeyboardEvent) => {
      const state = shortcutState.current
      if ((event.key !== ' ' && event.code !== 'Space') || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !state.source || state.settingsOpen) return
      const target = event.target instanceof Element ? event.target : null
      if (isTextEditing(target) || target?.closest('button, select, input[type="range"], a')) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) state.togglePlay()
    }
    window.addEventListener('keydown', playbackShortcut, true)
    window.addEventListener('keydown', shortcutsHandler)
    return () => {
      window.removeEventListener('keydown', playbackShortcut, true)
      window.removeEventListener('keydown', shortcutsHandler)
    }
  }, [])

  const scrub = (event: ReactPointerEvent, edge?: keyof Range, offset = 0) => {
    if (!track.current || !source || loading || (edge && selectedLocked)) return
    const rect = track.current.getBoundingClientRect()
    const pointer = toSource(timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left - offset) / rect.width))
    const drag = edge ? trimDrag.current : null
    const raw = pointer - (drag?.offset ?? 0)
    const time = Math.max(0, Math.min(duration, edge ? snap(raw) : raw))
    if (edge && drag) editBoundary(edge, time, drag.range)
    seek(time)
  }

  const startScrub = (event: ReactPointerEvent, edge?: keyof Range) => {
    if (!source || !track.current || loading || (edge && selectedLocked) || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    timelinePanned.current = true
    if (edge) {
      const rect = track.current.getBoundingClientRect()
      const pointer = toSource(timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width))
      trimDrag.current = { range, offset: pointer - range[edge] }
      seek(range[edge])
    } else scrub(event)
  }

  const startPlayheadDrag = (event: ReactPointerEvent) => {
    if (!track.current || loading || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    timelinePanned.current = true
    const rect = track.current.getBoundingClientRect()
    playheadOffset.current = event.clientX - rect.left - pct(toAxis(playbackClock.get())) * rect.width / 100
  }

  const startTrackDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (timelineZoom === 1) {
      startScrub(event)
      return
    }
    if (!source || loading || event.button !== 0) return
    timelineDrag.current = { x: event.clientX, start: visibleTime.start, width: event.currentTarget.clientWidth, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveTrackDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const drag = timelineDrag.current
    if (!drag) {
      scrub(event)
      return
    }
    const delta = drag.x - event.clientX
    if (!drag.moved && Math.abs(delta) < (event.pointerType === 'mouse' ? 5 : 10)) return
    drag.moved = true
    setGrabbingTimeline(true)
    timelinePanned.current = true
    setTimelineStart(panTimeline(axisDuration, timelineZoom, drag.start, delta / drag.width))
  }

  const finishTrackDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = timelineDrag.current
    if (drag && !drag.moved && event.currentTarget.hasPointerCapture(event.pointerId)) {
      video.current?.pause()
      const rect = event.currentTarget.getBoundingClientRect()
      seek(toSource(timelineTime(drag.start, visibleTime.span, (drag.x - rect.left) / rect.width)))
    }
  }

  const seekFromRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!source || loading || event.button !== 0) return
    video.current?.pause()
    scrub(event)
  }

  const disabled = !hasSource || loading
  const trimDisabled = disabled || selectedLocked
  const canSaveRange = validRange(range, duration)
  const editingCaptionJob = captionsRunning && Boolean(captionJob.current?.keys.has(captionKey))
  const canTrim = !trimDisabled && canSaveRange && !captionsRunning && !captionJob.current && (
    sections.length ? sections.some(section => rangesOverlap(section, range))
      : clips.length ? clips.some(clip => clipSegments(clip).some(segment => rangesOverlap(segment, range)))
        : range.start > 0 || range.end < duration
  )
  const batchCount = clips.length || (hasSource && !sections.length ? 1 : 0)
  const summary = exportBatch && summarizeExport(exportBatch.weights, exportBatch.states)
  const singleExport = busy ? exportBatch?.ranges.find(clip => clip.id === 0) : undefined
  const displayedClips = singleExport ? [singleExport, ...clips] : clips
  const captionLabel = selectedClip ? selectedClip.title || `Clip ${clips.indexOf(selectedClip) + 1}`
    : reviewed ? `Section ${(reviewIndex ?? 0) + 1}` : 'Current range'
  const showCaptionEditor = captionsOpen && !trimDisabled && canSaveRange
  const styleDockOpen = showCaptionEditor && styleDockKey === captionKey && Boolean(activeCaptions?.cues.length)
  const dockOpen = styleDockOpen || momentsOpen || Boolean(mediaDock)
  const openMediaDock = (dock: 'music' | 'bookends') => {
    setMomentsOpen(false)
    setStyleDockKey(null)
    setMediaDock(current => current === dock ? null : dock)
  }
  const closeMediaDock = (dock: 'music' | 'bookends') => {
    setMediaDock(null)
    requestAnimationFrame(() => document.getElementById(`${dock}-trigger`)?.focus())
  }
  const closeStyleDock = () => {
    setStyleDockKey(null)
    requestAnimationFrame(() => document.getElementById('caption-style-trigger')?.focus())
  }
  const backgroundStatus = [
    loading ? 'Opening video…' : preview === 'preparing' ? 'Preparing video preview…' : '',
    busy ? cancelingExport ? 'Canceling export…' : notice === 'Preparing caption artwork…'
      ? notice : `Exporting clips · ${summary?.percent ?? 0}%` : '',
    captionProgress ? progressLabel(captionProgress) + ('fraction' in captionProgress ? ` ${Math.round(captionProgress.fraction * 100)}%` : '') : '',
    titleProgress,
    momentRunning ? momentStatus || 'Preparing Smart Split…' : '',
  ].filter(Boolean).join('  ·  ')
  const status = backgroundStatus || notice || editStatus || (summary
    ? `Saved ${summary.saved} of ${summary.total} clips` : hasSource
      ? `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'} · ${stamp(duration)} source`
      : 'Ready to open a video')
  const runWindowAction = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void getCurrentWindow()[action]().catch(error => setNotice(message(error)))
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><Scissors size={19} /></span><span>MiniVidCut</span></div>
        <div className="titlebar-space" data-tauri-drag-region />
        <button className="icon-button settings-trigger" aria-label="Settings" title="Settings"
          aria-pressed={settingsOpen} onClick={() => setSettingsOpen(open => !open)}><SettingsIcon size={16} /></button>
        <div className="export-toolbar">
          <button id="music-trigger" className="button outline small media-trigger" aria-controls="music-menu"
            aria-expanded={mediaDock === 'music'} onClick={() => openMediaDock('music')}>
            <Music2 size={14} /> Background music
          </button>
          <button id="bookends-trigger" className="button outline small media-trigger" aria-controls="bookends-menu"
            aria-expanded={mediaDock === 'bookends'} disabled={disabled || busy} onClick={() => openMediaDock('bookends')}>
            <Clapperboard size={14} /> Intro / Outro
          </button>
          {busy && <div className="export-ring" role="progressbar" aria-label="Export progress"
            aria-valuenow={summary?.percent ?? 0} title={`Exporting · ${summary?.percent ?? 0}%`}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${summary?.percent ?? 0} 100`} />
            </svg>
          </div>}
          <button type="button" className="button primary small" popoverTarget="export-menu"
            aria-haspopup="dialog" disabled={disabled || busy || captionsRunning || Boolean(titleProgress) || renaming !== null || !batchCount || (!clips.length && !canSaveRange)}
            onClick={() => setSelectedExportOnly(false)}>
            <ArrowDownToLine size={14} /> Export <ChevronDown size={12} />
          </button>
          <form ref={exportMenu} id="export-menu" className="export-menu media-menu panel" popover="auto" role="dialog" aria-label="Export settings"
            onKeyDown={event => event.stopPropagation()} onSubmit={event => {
              event.preventDefault()
              exportMenu.current?.hidePopover()
              void exportVideos(selectedExportOnly ? selectedClip : undefined)
            }}>
            <label>Clips
              <select aria-label="Clips" value={selectedExportOnly && selectedClip ? 'selected' : 'all'} onChange={event => setSelectedExportOnly(event.target.value === 'selected')}>
                <option value="all">{clips.length ? `All clips (${clips.length})` : 'Current range'}</option>
                {selectedClip && <option value="selected">Selected clip</option>}
              </select>
            </label>
            <label>Export quality
              <select aria-label="Export quality" value={draftQuality} onChange={event => setQuality(event.target.value as Quality)}>
                <option value="compact">Compact (H.265)</option>
                <option value="compatible">Compatible (H.264)</option>
                <option value="lossless">Lossless (larger file)</option>
              </select>
            </label>
            <button className="button primary small" type="submit"><ArrowDownToLine size={14} /> Export</button>
          </form>
        </div>
        {isTauri() && <div className="window-controls" role="group" aria-label="Window controls">
          <button aria-label="Minimize" title="Minimize" onClick={() => runWindowAction('minimize')}><Minus size={15} /></button>
          <button aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => runWindowAction('toggleMaximize')}>
            {maximized ? <Copy size={13} /> : <Square size={12} />}
          </button>
          <button className="window-close" aria-label="Close" title="Close" onClick={() => runWindowAction('close')}><X size={16} /></button>
        </div>}
      </header>

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} onModelsChanged={(removed) => {
        if (removed) {
          localStorage.removeItem(TITLE_DOWNLOAD_KEY)
          localStorage.removeItem(AUTO_TITLES_KEY)
          setAutoTitles(false)
        }
        void refreshCaptionModel().catch(() => {})
      }} />
      <main hidden={settingsOpen} className={`workspace ${sections.length ? 'reviewing' : ''} ${dockOpen && wideWorkspace ? 'with-moments' : ''} ${timelineZoom > 1 ? 'timeline-zoomed' : ''}`}>
        <section className="viewer panel" aria-label="Video preview">
          <div className="panel-heading">
            <div className="source-line"><Film size={17} /><span title={source?.name}>{source?.name ?? 'Preview'}</span></div>
            <div className="viewer-actions">
              {!busy && Boolean(summary?.saved) && <button className="icon-button compact" title="Open export folder" aria-label="Open export folder"
                onClick={() => void invoke('open_export_folder').catch(error => setNotice(message(error)))}><FolderOpen size={15} /></button>}
              <button className="button outline small" onClick={() => void chooseVideo()} disabled={busy || loading}><FolderOpen size={15} /> Open video</button>
            </div>
          </div>
          <div className={`stage ${dragging ? 'dragging' : ''}`}>
            {hasSource ? (
              <>
                <div className={`canvas ${format} ${canPosition ? 'can-pan' : ''} ${panning ? 'panning' : ''}`}
                  onPointerDown={sequenceActive ? undefined : startPan} onPointerMove={movePan} onLostPointerCapture={endPan}>
                  {preview !== 'preparing' && preview !== 'unavailable' && (
                    <video key={`${sourceRequest.current}:${previewPath}`} ref={video} className={framing} src={convertFileSrc(previewPath)} muted={muted}
                      preload="auto" playsInline hidden={Boolean(sequence.path)} style={{ objectPosition }}
                      onClick={canPosition ? undefined : togglePlay}
                      onLoadedMetadata={event => {
                        const { videoWidth, videoHeight } = event.currentTarget
                        setPreviewAspect(videoHeight > 0 ? videoWidth / videoHeight : 0)
                        event.currentTarget.currentTime = Math.min(playbackClock.get(), event.currentTarget.duration)
                      }}
                      onTimeUpdate={event => {
                        if (performance.now() < ignoreTimeUpdateUntil.current) return
                        const player = event.currentTarget
                        const stop = playUntil.current
                        if (!player.paused && stop !== null && player.currentTime >= stop) {
                          player.pause()
                          seek(stop)
                        } else setPlaybackTime(Math.min(duration, player.currentTime))
                        syncMusic()
                      }}
                      onPlay={() => setPlaying(true)} onPlaying={() => syncMusic(true)}
                      onSeeking={() => musicPlayer.current?.pause()} onSeeked={() => syncMusic(true)}
                      onWaiting={() => musicPlayer.current?.pause()}
                      onPause={() => { setPlaying(false); musicPlayer.current?.pause() }}
                      onEnded={() => { setPlaying(false); musicPlayer.current?.pause() }}
                      onError={() => void useProxy()}
                    />
                  )}
                  {musicPath && canMixPreview && <audio key={musicPath} ref={setMusicPlayer}
                    src={convertFileSrc(musicPath)} preload="metadata" loop
                    onLoadedMetadata={() => syncMusic(true)}
                    onError={() => setNotice('This track could not play in preview. You can still export it.')} />}
                  {!sequence.path && activeCaptions && activeCaptions.cues.length > 0 && preview !== 'preparing' && preview !== 'unavailable' &&
                    <CaptionPreview key={previewPath} track={activeCaptions} format={format} video={video}
                      editable={showCaptionEditor && !editingCaptionJob} onStyle={saveCaptionStyle} />}
                  {sequence.stage}
                </div>
                {!sequenceActive && (preview === 'preparing' || preview === 'unavailable') && <div className="stage-message">
                  {preview === 'preparing' && <LoaderCircle size={24} className="spin" />}
                  {preview === 'preparing' ? 'Preparing a playable preview…' : 'Preview unavailable. You can still set times and export.'}
                </div>}
                {sequence.preparing && <div className="stage-message" role="status">
                  <LoaderCircle size={22} className="spin" /> Preparing full clip preview…
                  <button className="button outline small" onClick={stopSequence}>Cancel</button>
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
                {recovery && <div className="draft-recovery">
                  <p>Recovered draft for {recovery.source.name}</p>
                  <button className="button outline" disabled={loading} onClick={() => void loadVideo(recovery.source.path, recovery)}>Resume draft</button>
                  <button className="text-button" disabled={loading} onClick={() => void chooseVideo(recovery)}>Locate video</button>
                </div>}
                <span className="file-types">MP4, MOV, MKV, WebM and more</span>
              </div>
            )}
            {dragging && <div className="drop-overlay"><FolderOpen size={28} /> Drop to open video</div>}
          </div>
          <div className="transport">
            <div className="transport-playback" role="group" aria-label="Playback">
            <button className="icon-button compact" aria-label="Seek back 5 seconds" title="Back 5 seconds" disabled={disabled} onClick={() => seekPlayback(-5)}><Rewind size={15} /></button>
            <button className="icon-button compact" aria-label="Seek back 1 second" title="Back 1 second" disabled={disabled} onClick={() => seekPlayback(-1)}><ChevronLeft size={16} /></button>
            <button className="icon-button play" aria-label={sequence.preparing ? 'Cancel clip preview' : playerPlaying ? 'Pause' : 'Play'} title="Play / pause (Space)"
              onClick={togglePlay} disabled={!source || (!sequenceKey && !canMixPreview)}>
              {sequence.preparing ? <Square size={14} /> : playerPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button className="icon-button compact" aria-label="Seek forward 1 second" title="Forward 1 second" disabled={disabled} onClick={() => seekPlayback(1)}><ChevronRight size={16} /></button>
            <button className="icon-button compact" aria-label="Seek forward 5 seconds" title="Forward 5 seconds" disabled={disabled} onClick={() => seekPlayback(5)}><FastForward size={15} /></button>
            </div>
            <ClockDisplay duration={duration} />
          <div className="trim-bar" role="group" aria-label="Trim range">
            <TimeField label="In" value={range.start} disabled={trimDisabled} onChange={value => editBoundary('start', value)} onMark={() => editBoundary('start', activeTime())} />
            <TimeField label="Out" value={range.end} disabled={trimDisabled} onChange={value => editBoundary('end', value)} onMark={() => editBoundary('end', activeTime())} />
            <button className="icon-button compact" title="Reset trim range" aria-label="Reset trim range" onClick={resetRange} disabled={trimDisabled}><RotateCcw size={15} /></button>
            <button className="icon-button compact clip-commit" disabled={!selectedLocked && (trimDisabled || !canSaveRange || editingCaptionJob)}
              aria-label={selectedLocked ? 'New clip' : selectedId === null ? 'Add clip' : 'Update clip'}
              title={selectedLocked ? 'New clip' : selectedId === null ? 'Add clip' : 'Update clip'}
              onClick={selectedLocked ? resetRange : addClip}>{selectedLocked || selectedId === null ? <Plus size={16} /> : <Check size={16} />}</button>
          </div>
            <div className="transport-tools">
            {sequence.path && <button className="icon-button compact" title="Return to source preview" aria-label="Return to source preview"
              onClick={stopSequence}><X size={16} /></button>}
            {canPosition && positionAxis && <>
              <button className="icon-button compact position-trigger" aria-label="Frame position" title="Frame position" popoverTarget="frame-position"
                aria-haspopup="dialog"><Move size={16} /></button>
              <div id="frame-position" className="position-controls panel" popover="auto" role="dialog" aria-label="Frame position">
              <label title="Drag the preview or use the slider to position every exported clip"><Move size={15} />
                <span>Position</span>
                <input aria-label={positionAxis === 'x' ? 'Horizontal frame position' : 'Vertical frame position'}
                  type="range" min="0" max="100" value={position[positionAxis]}
                  onChange={event => setFramePosition({ ...position, [positionAxis]: Number(event.target.value) })} />
              </label>
              <button className="button outline small" title="Center picture in frame" onClick={() => setFramePosition(CENTER)}>Center</button>
            </div></>}
            {hasSource && <button className={`icon-button compact caption-toggle${activeCaptions?.cues.length ? ' has-captions' : ''}`}
              title="Captions" aria-label="Captions" aria-expanded={captionsOpen} aria-controls="captions-panel"
              onClick={() => captionsOpen ? closeCaptions() : openCaptions()}>
              {captionsRunning ? <LoaderCircle size={17} className="spin" /> : <Subtitles size={18} />}
            </button>}
            <div className="transport-audio" role="group" aria-label="Preview audio">
              <button className="icon-button compact mute" aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} disabled={!source} onClick={() => {
                const next = !muted
                setMuted(next)
                if (sequence.player.current) sequence.player.current.muted = next
              }}>
                {muted || !previewVolume ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <input aria-label="Preview volume" title="Preview volume" type="range" min={0} max={100}
                value={muted ? 0 : previewVolume} disabled={!source}
                onChange={event => {
                  setPreviewVolume(event.target.valueAsNumber)
                  setMuted(false)
                  if (sequence.player.current) sequence.player.current.muted = false
                }} />
            </div>
            </div>
          </div>
          <div className="output-bar">
            <div className="segmented format-options" role="group" aria-label="Output format">
              {(Object.keys(FORMATS) as Format[]).map(option => {
                const { icon: Icon, label, ratio } = FORMATS[option]
                return <button key={option} title={`${label} ${ratio}`} aria-pressed={option === format} disabled={selectedLocked}
                  onClick={() => setFormat(option)}><Icon size={14} /><span>{label}</span></button>
              })}
            </div>
            <div className="segmented" role="group" aria-label="Framing">
              <button aria-pressed={framing === 'fill'} title="Crop to fill the frame" disabled={selectedLocked} onClick={() => setFraming('fill')}>Fill</button>
              <button aria-pressed={framing === 'fit'} title="Keep the full image with black borders" disabled={selectedLocked} onClick={() => setFraming('fit')}>Fit</button>
            </div>
            <span className="resolution">{activeFormat.ratio} <span>·</span> {activeFormat.size}</span>
          </div>
        </section>

        <aside className="editor-sidebar panel" aria-label="Clips and captions" hidden={dockOpen && !wideWorkspace}>
          <div className="sidebar-tabs" role="tablist" aria-label="Editor sidebar" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            event.stopPropagation()
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
              : (current + tabs.length + (event.key === 'ArrowLeft' ? -1 : 1)) % tabs.length
            tabs[next]?.focus()
            tabs[next]?.click()
          }}>
            <button ref={clipsTab} type="button" role="tab" id="clips-tab" aria-selected={!captionsOpen} aria-controls="clips-panel"
              tabIndex={captionsOpen ? -1 : 0} onClick={() => setCaptionsOpen(false)}>
              <Clapperboard size={15} /> Clips <span className="count">{displayedClips.length}</span>
            </button>
            <button ref={captionsTab} type="button" role="tab" id="captions-tab" aria-selected={captionsOpen} aria-controls="captions-panel"
              tabIndex={captionsOpen ? 0 : -1} onClick={() => openCaptions()}>
              <Subtitles size={16} /> Captions {captionsRunning && <LoaderCircle size={13} className="spin" aria-label="Generating captions" />}
            </button>
            {!wideWorkspace && <button type="button" role="tab" aria-selected={false} tabIndex={-1}
              disabled={!source || loading} aria-controls="moment-panel" onClick={() => { setMediaDock(null); setMomentsOpen(true) }}>Smart Split</button>}
          </div>
          <div className="sidebar-content" id="captions-panel" role="tabpanel" aria-labelledby="captions-tab" hidden={!captionsOpen}>
            {showCaptionEditor ? <CaptionEditor key={captionKey} label={captionLabel} range={range} track={activeCaptions}
          model={captionModel} progress={captionProgress} status={captionStatus?.key === captionKey || captionStatus?.key === 'batch' ? captionStatus.text : ''}
          editing={editingCaptionJob} canGenerate={!titleProgress} styleOpen={styleDockOpen}
          defaultStyle={sharedCaptionStyle.current ?? undefined} onOpenStyle={() => {
            if (styleDockOpen) closeStyleDock()
            else {
              setMomentsOpen(false)
              setMediaDock(null)
              setStyleDockKey(captionKey)
              requestAnimationFrame(() => document.getElementById('caption-style-title')?.focus())
            }
          }}
          onChange={saveCaptions} onGenerate={generateCaptions} onCancel={cancelCaptions}
          onSeek={captionSeek} getTime={captionPlayhead} /> : <div className="empty-queue">
            <Subtitles size={21} />
            <p>{!hasSource ? 'Open a video to add captions.' : selectedLocked ? 'This clip is locked while it exports.' : 'Select a range to add captions.'}</p>
          </div>}
          </div>
          <div className="sidebar-content queue" id="clips-panel" role="tabpanel" aria-labelledby="clips-tab" hidden={captionsOpen}>
          {displayedClips.length > 0 && <div className="panel-heading">
            <button className="button outline small" aria-pressed={autoTitles} disabled={disabled || busy || captionsRunning || Boolean(titleProgress)}
              onClick={() => void toggleAutoTitles()}><Sparkles size={14} /> Auto-title</button>
            <button className="button outline small" title="Generate captions for clips without captions" disabled={disabled || busy || captionsRunning || Boolean(titleProgress) || !clipsNeedingCaptions(clips).length}
              onClick={captionStack}><Subtitles size={14} /> Caption all</button>
          </div>}
          {(titleProgress || titleError) && <div className="export-detail title-status" role="status">{titleProgress || titleError}
            {titleError && autoTitles && <button className="text-button" onClick={() => {
              titledClips.current.clear()
              setTitleError('')
            }}>Retry</button>}
          </div>}
          {summary && <section className="export-summary" aria-label="Batch export">
            <div className="export-heading">
              <strong>{busy ? cancelingExport ? 'Canceling export' : 'Exporting clips' : summary.canceled ? 'Export canceled' : summary.failed ? 'Export finished with errors' : 'Export complete'}</strong>
              <span>{busy ? `${summary.percent}%` : summary.bytes > 0 ? fileSize(summary.bytes) : null}</span>
            </div>
            <div className={`batch-meter ${summary.failed ? 'has-errors' : ''}`} role="progressbar"
              aria-label="Overall export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}>
              <span style={{ width: `${summary.percent}%` }} />
            </div>
            <div className="export-detail">
              <span>{summary.saved} of {summary.total} saved{summary.active > 0 && ` · ${summary.active} exporting`}{summary.failed > 0 && ` · ${summary.failed} failed`}</span>
              {busy && <button className="text-button" disabled={cancelingExport} onClick={cancelExport}>Cancel export</button>}
            </div>
          </section>}
          {displayedClips.length === 0 ? <div className="empty-queue"><Scissors size={20} strokeWidth={1.5} /><span>No clips added</span><p>Add a trim range or split it into clips.</p></div> :
            <ol className="clip-list">{displayedClips.map((clip, index) => {
              const batchIndex = batchIndices.get(clip.id)
              const state = batchIndex === undefined ? undefined : exportBatch?.states[batchIndex]
              const locked = clipLocked(clip.id)
              const clipOptions = locked ? exportBatch?.options : undefined
              const thumbPosition = clipOptions?.position ?? position
              const title = clip.title ?? `Clip ${String(index + 1).padStart(2, '0')}`
              const editing = renaming === clip.id
              return <li key={clip.id} className={clip.id === selectedId ? 'selected' : ''}>
                {editing ? <form className="clip-rename" aria-label="Edit clip title" onSubmit={event => {
                  event.preventDefault()
                  const value = String(new FormData(event.currentTarget).get('title') ?? '')
                  renameClip(clip.id, value === title && !clip.title ? '' : value)
                }} onKeyDown={event => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setRenaming(null)
                  }
                }}>
                  <input autoFocus name="title" aria-label={`Rename ${title}`} maxLength={80} defaultValue={title}
                    onFocus={event => event.currentTarget.select()}
                  />
                  <button type="submit" className="icon-button compact save-title" title="Save title" aria-label="Save title"><Check size={15} /></button>
                  <button type="button" className="icon-button compact" title="Cancel rename" aria-label="Cancel rename" onClick={() => setRenaming(null)}><X size={14} /></button>
                </form> : <button className="clip-select" aria-pressed={clip.id === selectedId} disabled={disabled}
                  title={locked ? `${title} · Preview only during export` : `${title} · Double-click to rename`}
                  onClick={event => {
                    if (event.detail === 1) renameClick.current = clip.id
                    selectClip(clip)
                  }}
                  onDoubleClick={() => {
                    if (locked || renameClick.current !== clip.id) return
                    renameClick.current = null
                    setRenaming(clip.id)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'F2' && !locked) {
                      event.preventDefault()
                      renameClick.current = null
                      setRenaming(clip.id)
                    }
                  }}>
                  <span className="clip-thumbnail" style={{ aspectRatio: FORMATS[clipOptions?.format ?? format].aspect }}>
                    {clipFrames[clip.start]
                      ? <img alt="" src={clipFrames[clip.start]} style={{ objectFit: (clipOptions?.framing ?? framing) === 'fill' ? 'cover' : 'contain', objectPosition: `${thumbPosition.x}% ${thumbPosition.y}%` }} />
                      : <Film size={15} />}
                  </span>
                  <span className="clip-details">
                    <span className="clip-title-line"><strong>{title}</strong>
                      <span className="clip-length" style={{ color: clipColor(clip.id) }}
                        title={`Duration · ${stamp(clip.end - clip.start, true)}`}>{clipDuration(clip.end - clip.start)}</span>
                    </span>
                    <small>{stamp(clip.start, true)} – {stamp(clip.end, true)}</small>
                  </span>
                </button>}
                {state && <ExportBadge state={state} />}
                {!locked && !editing && <button className="icon-button compact clip-more" aria-label={`Actions for ${title}`} title="Clip actions"
                  aria-expanded={clipActions === clip.id} aria-controls={clipActions === clip.id ? `clip-actions-${clip.id}` : undefined}
                  disabled={disabled} onClick={() => setClipActions(current => current === clip.id ? null : clip.id)}><Ellipsis size={17} /></button>}
                {!locked && !editing && clipActions === clip.id && <ClipActions id={`clip-actions-${clip.id}`} label={`Actions for ${title}`} onClose={closeClipActions}>
                  <button disabled={busy || captionsRunning || Boolean(titleProgress)} onClick={() => { setClipActions(null); captionClip(clip) }}>
                    <Subtitles size={15} /> {clipsNeedingCaptions([clip]).length ? 'Generate captions' : 'Edit captions'}
                  </button>
                  <button disabled={busy || captionsRunning || Boolean(titleProgress)} onClick={() => { setClipActions(null); void titleClip(clip) }}>
                    <Sparkles size={15} /> {clip.title ? 'Retitle with AI' : 'Title with AI'}
                  </button>
                  <button onClick={() => { setClipActions(null); setRenaming(clip.id) }}><Pencil size={14} /> Edit title</button>
                  <button disabled={busy || clips.length >= MAX_CLIPS} onClick={() => {
                    const copy = { ...clip, id: nextId.current++, title: clip.title ? `${clip.title.slice(0, 73)} (copy)` : undefined }
                    setClips(items => items.flatMap(item => item.id === clip.id ? [item, copy] : [item]))
                    setClipActions(null)
                    selectClip(copy)
                  }}><Copy size={14} /> Duplicate clip</button>
                  <button disabled={captionJob.current?.keys.has(`clip-${clip.id}`)} onClick={() => {
                    setClipActions(null)
                    setClips(items => items.filter(item => item.id !== clip.id))
                    if (selectedId === clip.id) setSelectedId(null)
                  }}><Trash2 size={14} /> Remove clip</button>
                </ClipActions>}
                {state?.status === 'encoding' && <div className="clip-meter" aria-hidden="true"><span style={{ width: `${state.fraction * 100}%` }} /></div>}
              </li>
            })}</ol>}
          </div>
        </aside>
          <MusicMenu key={`music-${musicSourceRevision}`} project={projectMusic}
            clip={selectedClip ? { music: selectedClip.music, title: selectedClip.title || 'Selected clip' } : null}
            open={mediaDock === 'music'} onClose={() => closeMediaDock('music')}
            disabled={disabled || busy} canPreview={canMixPreview && Boolean(musicPath) && validRange(range, duration)}
            playing={playerPlaying} onPreview={playMusicMix} onChange={changeMusic} onKainoCacheChange={refreshKainoTrack} />
          <BookendsMenu key={`bookends-${musicSourceRevision}`} project={projectBookends}
            clip={selectedClip ? { bookends: selectedClip.bookends, title: selectedClip.title || 'Selected clip' } : null}
            open={mediaDock === 'bookends'} onClose={() => closeMediaDock('bookends')}
            aspect={activeFormat.aspect} disabled={disabled || busy} videoExtensions={EXTENSIONS} onChange={changeBookend}
            canPreview={Boolean(sequenceKey && validRange(range, duration))} onPreview={playSequence} />
          {styleDockOpen && activeCaptions && <CaptionStylePanel key={captionKey} style={activeCaptions.style}
            format={format} editing={editingCaptionJob} canApplyStyle={!busy && !captionsRunning}
            onStyle={saveCaptionStyle} onApplyStyle={applyCaptionStyle} onClose={closeStyleDock} />}
          <section className="moment-panel panel" id="moment-panel" aria-label="Smart Split suggestions" hidden={!momentsOpen}>
            {!wideWorkspace && <div className="sidebar-tabs" role="tablist" aria-label="Editor sidebar">
              <button role="tab" aria-selected={false} aria-controls="clips-panel" onClick={() => {
                setMomentsOpen(false)
                setCaptionsOpen(false)
                requestAnimationFrame(() => clipsTab.current?.focus())
              }}>Clips</button>
              <button role="tab" aria-selected={false} aria-controls="captions-panel" onClick={() => {
                setMomentsOpen(false)
                openCaptions()
                requestAnimationFrame(() => captionsTab.current?.focus())
              }}>Captions</button>
              <button role="tab" aria-selected aria-controls="moment-panel" onKeyDown={event => {
                const tabs = event.currentTarget.parentElement?.querySelectorAll('button')
                if (event.key === 'ArrowLeft' || event.key === 'End') tabs?.[1].click()
                else if (event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'Escape') tabs?.[0].click()
                else return
                event.preventDefault()
                event.stopPropagation()
              }}>Smart Split</button>
            </div>}
            {wideWorkspace && <header className="moment-heading">
              <h2><Sparkles size={15} /> Smart Split</h2>
              <button className="icon-button compact" type="button" aria-label="Close Smart Split" title="Close Smart Split" onClick={() => {
                setMomentsOpen(false)
                momentsTrigger.current?.focus()
              }}><X size={16} /></button>
            </header>}
            <form className="moment-controls" onSubmit={event => {
              event.preventDefault()
              const fields = new FormData(event.currentTarget)
              void searchMoments(String(fields.get('prompt') || '').trim() || DEFAULT_MOMENT_QUERY,
                Number(fields.get('maximum')), Number(fields.get('maxResults')))
            }}>
              <input type="text" name="prompt" maxLength={240} aria-label="Describe the moments to find" placeholder="Most important takeaways" />
              <div className="moment-controls-row">
              <label><span>Max length</span><span className="moment-limit"><input type="number" name="maximum" min={1} max={120} defaultValue={30} required aria-label="Maximum seconds per clip" /> s</span></label>
              <label><span>Max clips</span><input type="number" name="maxResults" min={1} max={MAX_CLIPS} defaultValue={5} required aria-label="Maximum suggested clips" /></label>
              <button className="button outline small" disabled={momentRunning || captionsRunning || Boolean(titleProgress) || loading} type="submit"><Sparkles size={14} /> Find</button>
              </div>
            </form>
            {momentRunning ? <div className="moment-progress">
              <div className="moment-progress-heading">
                <p role="status">{momentStatus}</p>
                <button className="button outline small" type="button" onClick={stopMomentSearch} disabled={momentStopping}>{momentStopping ? 'Stopping…' : 'Stop'}</button>
              </div>
              <progress aria-label="Smart Split progress" max={1} value={momentProgress ?? undefined} />
            </div> : momentStatus && <p className="moment-status" role="status">{momentStatus}</p>}
            {moments.length > 0 && <ol className="moment-results">
              {moments.map(moment => {
                const added = clips.some(clip => clip.start === moment.start && clip.end === moment.end)
                return <li key={`${moment.start}:${moment.end}`}>
                  <button className="icon-button compact" title="Play suggestion" aria-label={`Play suggestion at ${stamp(moment.start, true)}`}
                    disabled={preview !== 'direct' && preview !== 'proxy'} onClick={() => previewMoment(moment)}><Play size={14} /></button>
                  <span><small>{stamp(moment.start, true)} – {stamp(moment.end, true)}</small><strong title={moment.text}>{moment.text}</strong></span>
                  <button className="button outline small" disabled={added || busy || clips.length >= MAX_CLIPS}
                    onClick={() => addMoment(moment)}>{added ? <Check size={14} /> : <Plus size={14} />}{added ? 'Added' : 'Add clip'}</button>
                </li>
              })}
            </ol>}
          </section>

        <section className="timeline panel" aria-label="Timeline">
          <div className="panel-heading timeline-heading">
            <div className="source-line"><Scissors size={17} /><span>Timeline</span></div>
            <div className="segmented timeline-view" role="group" aria-label="Timeline view">
              <button aria-pressed={timelineView === 'source'} onClick={() => setTimelineView('source')}>Source</button>
              <button aria-pressed={timelineView === 'sequence'} disabled={!clips.length} onClick={() => setTimelineView('sequence')}>Sequence</button>
            </div>
            <button className="button outline small trim-section" disabled={!canTrim}
              title="Remove the In–Out selection from every clip on the timeline" onClick={trimSection}><ScissorsLineDashed size={15} /> Trim</button>
            <button className="icon-button compact" title="Undo (Ctrl Z)" aria-label="Undo" disabled={!canUndo} onClick={undoEdit}><Undo2 size={15} /></button>
            <button className="icon-button compact" title="Redo (Ctrl Shift Z)" aria-label="Redo" disabled={!canRedo} onClick={redoEdit}><Redo2 size={15} /></button>
            <button className="button outline small" title="Add a cut inside the selected clip at the playhead (S)"
              disabled={!selectedClip || selectedLocked || busy} onClick={splitClip}><Scissors size={14} /> Cut</button>
            <button className="icon-button compact" title="Remove the selected clip (Delete)" aria-label="Remove selected clip"
              disabled={!selectedClip || selectedLocked || busy} onClick={deleteClip}><Trash2 size={15} /></button>
            <button className={`icon-button compact ${snapping ? 'active' : ''}`} title={snapping ? 'Snapping on' : 'Snapping off'}
              aria-label="Toggle snapping" aria-pressed={snapping} onClick={() => setSnapping(on => !on)}><Magnet size={15} /></button>
            <div className="timeline-zoom" role="group" aria-label="Timeline zoom">
              <button className="icon-button compact" aria-label="Zoom out timeline" title="Zoom out"
                disabled={disabled || timelineZoom === 1} onClick={() => zoomTimelineTo(timelineZoom / 2)}><ZoomOut size={16} /></button>
              <button className="button outline small" aria-label="Fit entire timeline" title="Fit entire timeline"
                disabled={disabled || timelineZoom === 1} onClick={() => zoomTimelineTo(1)}>Fit</button>
              <button className="icon-button compact" aria-label="Zoom in timeline" title="Zoom in"
                disabled={disabled || timelineZoom === MAX_TIMELINE_ZOOM} onClick={() => zoomTimelineTo(timelineZoom * 2)}><ZoomIn size={16} /></button>
            </div>
            <button ref={momentsTrigger} className="button outline small smart-split" disabled={disabled}
              aria-expanded={momentsOpen} aria-controls="moment-panel"
              onClick={() => { setSplitOpen(false); setStyleDockKey(null); setMediaDock(null); setMomentsOpen(open => !open) }}><Sparkles size={14} /> Smart Split</button>
            <div className="split">
              <button className="button outline small" disabled={trimDisabled || !canSaveRange || editingCaptionJob} onClick={() => setSplitOpen(!splitOpen)} aria-expanded={splitOpen}><Split size={15} /> Split range <ChevronDown size={13} /></button>
              {splitOpen && canSaveRange && !trimDisabled && <div className="split-menu">
                <div className="segmented split-mode" role="group" aria-label="Split behavior">
                  <button aria-pressed={splitMode === 'mark'} onClick={() => setSplitMode('mark')}>Mark only</button>
                  <button aria-pressed={splitMode === 'add'} onClick={() => setSplitMode('add')}>Split &amp; add</button>
                </div>
                <button onClick={splitAtPlayhead}>At playhead</button>{[15, 30, 60, 120, 300].map(seconds =>
                  <button key={seconds} onClick={() => splitParts(splitRange(range, seconds))}>{seconds < 60 ? `Every ${seconds}s` : `Every ${seconds / 60} min`}</button>)}
              </div>}
            </div>
          </div>
          <div className="timeline-body" ref={timelineBody}>
            <div className={`ruler ${hasSource ? 'seekable' : ''}`} aria-hidden="true" onPointerDown={seekFromRuler}>{[0, 1, 2, 3, 4, 5].map(step => <span key={step}>{axisDuration
              ? stamp(timelineTime(visibleTime.start, visibleTime.span, step / 5), visibleTime.span < 5)
              : step === 0 ? '00:00:00' : ''}</span>)}</div>
            <div className={`track ${hasSource ? 'loaded' : ''} ${grabbingTimeline ? 'grabbing' : ''}`} ref={track}
              onPointerDown={startTrackDrag} onPointerMove={moveTrackDrag} onPointerUp={finishTrackDrag}
              onLostPointerCapture={() => { timelineDrag.current = null; setGrabbingTimeline(false) }}>
              {hasSource ? (
                <>
                  <div className="filmstrip" aria-hidden="true">{filmTiles.map(tile => {
                    const sourceTime = toSource(tile.time)
                    const overview = overviewTiles[Math.min(9, Math.floor(sourceTime / duration * 10))]
                    const frame = frames[sourceTime] || frames[overview?.time]
                    return <div className="frame-tile" key={tile.index} style={{ left: `${tile.left}%` }}>
                      {frame && <img draggable={false} alt="" src={frame} />}
                    </div>
                  })}</div>
                  {timelineView === 'source'
                    ? clips.flatMap(clip => clipSegments(clip).map((segment, index, all) => ({ clip, segment, index, all })))
                      .filter(({ segment }) => pct(segment.end) > pct(segment.start))
                      .map(({ clip, segment, index, all }) => <Fragment key={`${clip.id}-${index}`}>
                        <div className={`clip-tint ${clip.id === selectedId ? 'selected' : ''}`}
                          style={{ left: `${pct(segment.start)}%`, width: `${pct(segment.end) - pct(segment.start)}%`, backgroundColor: clipColor(clip.id) + '35', borderColor: clipColor(clip.id) }} />
                        {index > 0 && inView(segment.start) && <div className="cut-notch" title="Cut point — this part is skipped on export"
                          style={{ left: `${pct(all[index - 1].end)}%`, borderColor: clipColor(clip.id) }} />}
                      </Fragment>)
                    : sequenceMap.pieces.map((piece, index) => <div key={`${piece.clipId}-${index}`}
                        className={`sequence-piece ${piece.clipId === selectedId ? 'selected' : ''} ${reorderTarget === index ? 'drop-target' : ''}`}
                        style={{ left: `${pct(piece.start)}%`, width: `${pct(piece.end) - pct(piece.start)}%`,
                          backgroundColor: clipColor(piece.clipId) + '45', borderColor: clipColor(piece.clipId) }}
                        title={`${stamp(piece.segment.start, true)} – ${stamp(piece.segment.end, true)} · drag to reorder`}
                        onPointerDown={event => startClipReorder(event, clips.findIndex(clip => clip.id === piece.clipId))}
                        onPointerMove={moveClipReorder} onPointerUp={finishClipReorder}
                        onClick={() => {
                          if (reorderMoved.current) { reorderMoved.current = false; return }
                          const clip = clips.find(item => item.id === piece.clipId)
                          if (clip) selectClip(clip)
                        }}
                        onLostPointerCapture={() => { clipReorder.current = null; reorderTargetRef.current = null; setReorderTarget(null) }}>
                        <span>{stamp(piece.segment.end - piece.segment.start)}</span>
                      </div>)}
                  {timelineView === 'source' && overlaps.map(overlap => pct(overlap.end) > pct(overlap.start) && <div key={overlap.start} className="overlap-line"
                    title="Overlapping clips" style={{ left: `${pct(overlap.start)}%`, width: `${pct(overlap.end) - pct(overlap.start)}%` }} />)}
                  {timelineView === 'source' && <>
                    <div className="range-shade" style={{ width: `${pct(range.start)}%` }} />
                    <div className="range-shade right" style={{ width: `${100 - pct(range.end)}%` }} />
                    <div className="selection" style={{ left: `${pct(range.start)}%`, width: `${pct(range.end) - pct(range.start)}%` }} />
                    {moments.filter(moment => pct(moment.end) > pct(moment.start)).map(moment =>
                      <div className="moment-mark" key={`${moment.start}:${moment.end}`} aria-hidden="true"
                        style={{ left: `${pct(moment.start)}%`, width: `${pct(moment.end) - pct(moment.start)}%` }} />)}
                    {[...new Set(sections.flatMap(section => [section.start, section.end]))].filter(point => point > 0 && point < duration && inView(point)).map(point =>
                      <div className="section-mark" key={point} style={{ left: `${pct(point)}%` }} />)}
                  </>}
                  {(['start', 'end'] as const).filter(edge => inView(toAxis(range[edge]))).map(edge => <button key={edge} className={`handle ${edge}`} disabled={trimDisabled}
                    aria-label={edge === 'start' ? 'Drag trim start' : 'Drag trim end'}
                    data-tight={pct(toAxis(range.end)) - pct(toAxis(range.start)) < 5}
                    style={{ left: `clamp(0px, calc(${pct(toAxis(range[edge]))}% - ${edge === 'end' ? 11 : 0}px), calc(100% - 11px))` }}
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
                  {selectedClip && !selectedLocked && !busy && (['start', 'end'] as const)
                    .filter(side => inView(toAxis(selectedClip[side]))).map(side => <button key={`clip-${side}`}
                      className={`handle clip-edge ${side}`} aria-label={`Drag clip ${side} to trim`}
                      title={`Drag to trim the clip's ${side}`}
                      style={{ left: `clamp(0px, calc(${pct(toAxis(selectedClip[side]))}% - ${side === 'end' ? 11 : 0}px), calc(100% - 11px))` }}
                      onPointerDown={event => startClipEdgeDrag(event, selectedClip, side)}
                      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveClipEdgeDrag(event) }}
                      onLostPointerCapture={() => { clipEdgeDrag.current = null }}><span /></button>)}
                  <TimelinePlayhead pct={sourceTime => pct(toAxis(sourceTime))} inView={sourceTime => inView(toAxis(sourceTime))} onDrag={startPlayheadDrag}
                    onMove={event => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event, undefined, playheadOffset.current)
                    }} />
                </>
              ) : <span className="empty-track"><Film size={16} /> Open a video to start trimming</span>}
            </div>
            {timelineView === 'source' && clips.length > 0 && <div className="clip-strip" aria-label="Saved clip ranges">
              {clips.flatMap((clip, index) => clipSegments(clip).map((segment, part) => ({ clip, index, segment, part })))
                .filter(({ segment }) => segment.end > visibleTime.start && segment.start < visibleTime.end)
                .map(({ clip, index, segment, part }) => <button key={`${clip.id}-${part}`} className={clip.id === selectedId ? 'selected' : ''}
                  title={`Clip ${index + 1}${part ? ` · cut ${part + 1}` : ''} · ${stamp(segment.start, true)} – ${stamp(segment.end, true)}`}
                  aria-label={`Select clip ${index + 1}${part ? `, part ${part + 1}` : ''} on timeline`} disabled={disabled}
                  aria-pressed={clip.id === selectedId}
                  style={{ left: `${pct(segment.start)}%`, width: `${pct(segment.end) - pct(segment.start)}%`, backgroundColor: clipColor(clip.id) }}
                  onClick={() => selectClip(clip)} />)}
            </div>}
            {source && <AccessibleScrubber duration={duration} seek={seek} />}
          </div>
          {timelineZoom > 1 && <div ref={timelineScroll} className="timeline-pan" tabIndex={0} aria-label="Scroll timeline"
            onScroll={event => {
              const bar = event.currentTarget
              const travel = bar.scrollWidth - bar.clientWidth
              if (!travel) return
              const start = bar.scrollLeft / travel * visibleTime.maxStart
              if (Math.abs(start - visibleTime.start) / visibleTime.maxStart <= 1 / travel) return
              timelinePanned.current = true
              setTimelineStart(start)
            }}><div style={{ width: `${timelineZoom * 100}%` }} /></div>}
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
        <div className="status-left" role="status"><span aria-hidden="true" className={`status-dot ${backgroundStatus ? 'active' : notice ? 'error' : ''}`} />
          <span className="status-text" title={status}>{status}</span>
        </div>
        <button className="text-button footer-shortcuts" onClick={() => setShortcuts(true)}><Keyboard size={15} /> Shortcuts</button>
      </footer>
      {shortcuts && <div className="dialog-backdrop" onClick={() => setShortcuts(false)}>
        <section className="shortcut-dialog panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={event => event.stopPropagation()}>
          <div className="section-title"><h2>Keyboard shortcuts</h2><button autoFocus className="icon-button" aria-label="Close shortcuts" onClick={() => setShortcuts(false)}><X size={18} /></button></div>
          <dl>{[['Open video', 'Ctrl O'], ['Play / pause', 'Space'], ['Zoom in', 'Ctrl + scroll up / Ctrl +'], ['Zoom out', 'Ctrl + scroll down / Ctrl -'], ['Pan timeline', 'Shift scroll / sideways scroll'], ['Fit timeline', 'Ctrl 0'], ['Seek 1 second', '← / →'], ['Seek 5 seconds', 'Shift ← / →'], ['Mark In', 'I'], ['Mark Out', 'O'], ['Add or update clip', 'Enter'], ['Cut inside clip', 'S'], ['Remove selected clip', 'Delete'], ['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z']].map(([label, key]) =>
            <div key={label}><dt>{label}</dt><dd><Key>{key}</Key></dd></div>)}</dl>
        </section>
      </div>}
    </div>
  )
}
