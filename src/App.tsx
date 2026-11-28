import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import {
  ArrowDownToLine, AudioLines, Check, ChevronLeft, ChevronRight, Clapperboard, Copy, Crop, FastForward, Film, FolderOpen,
  Keyboard, LoaderCircle, Minus, Monitor, Move, Music2, Pause, Pencil, Play, Plus, Redo2, Rewind, RotateCcw,
  Scissors, ScissorsLineDashed, Search, Settings as SettingsIcon, SlidersHorizontal, Smartphone, Sparkles, Split, Square, Subtitles, Trash2, Type,
  Undo2, Volume2, VolumeX, X, ZoomIn, ZoomOut,
  BookOpen, Flame, Heart, Laugh, Lightbulb, ListChecks, Quote, Rocket, Sun, Zap,
} from 'lucide-react'
import {
  clipDuration, clipSegments, cutRange, deleteFromRanges, exportUnits, keptDuration, MAX_CLIPS,
  moveBoundary, normalizeClip, parseTime, rangesOverlap, resizeClipEdge, segmentAt, splitRange, stamp,
  trimClips, validRange, withSegments,
} from './clip'
import type { Clip, ExportUnit, Range } from './clip'
import { MAX_TIMELINE_ZOOM, panTimeline, timelineFrames, timelineOverlaps, timelineTime, timelineWindow, ZOOM_STEPS, zoomAround, zoomTimeline } from './timeline'
import { CENTER, frameTravel, panPosition } from './framing'
import type { FramePosition, Framing } from './framing'
import { groupExportStates, summarizeExport } from './export-progress'
import type { ExportProgress, ExportState } from './export-progress'
import { ClipRow, clipColor } from './ClipRow'
import type { ClipRowActions } from './ClipRow'
import { ContextMenu } from './ContextMenu'
import type { MenuItem, MenuState } from './ContextMenu'
type MomentPick = { index: number | null; confident: boolean }
import { Settings } from './Settings'
import type { Section } from './Settings'
import { AgentSetup } from './AgentSetup'
import { PercentInput } from './PercentInput'
import { AGENT_CANCELED, AGENT_SIGNED_OUT, AgentFormatError, agentMessage, agentMeta, buildAgentPrompt, buildTitlePrompt, parseAgentClips, parseAgentTitle, pickBest, windowCues, AGENT_CHUNK_SECONDS } from './agents'
import { UpdateIndicator, UpdatePrompt } from './UpdatePrompt'
import { useAppUpdate } from './useAppUpdate'
import { exportFileName, readPreferences, writePreferences } from './preferences'
import type { AgentId, Format, Preferences, Quality } from './preferences'
import { CaptionEditor, CaptionStylePanel, progressLabel } from './CaptionEditor'
import { CaptionPreview } from './CaptionPreview'
import { prepareCaptionOverlay } from './caption-export'
import { TextMenu } from './TextMenu'
import type { TextEntry } from './TextMenu'
import { TextOverlayPreview } from './TextOverlayPreview'
import { createTextOverlay, migrateLegacyText, moveText, normalizeText, normalizeTexts, spreadTextToTargets, textActive, TEXT_MAX_LAYERS } from './text-overlay'
import type { TextOverlay } from './text-overlay'
import type { CaptionModel, CaptionProgress } from './CaptionEditor'
import { captionCut, captionSlice, captionsForKept, clipsNeedingCaptions, DEFAULT_CAPTION_STYLE, offsetCaption, restyleCaptionedClip } from './captions'
import type { CaptionCue, CaptionStyle, CaptionTrack } from './captions'
import { DEFAULT_MOMENT_QUERY, missingTranscriptRanges, MOMENT_BATCH_SECONDS, MOMENT_PRESETS, momentCandidates, momentLimit, momentRequest, momentWorthy } from './moments'
import type { Moment } from './moments'
import { MusicMenu } from './MusicMenu'
import { Waveform } from './Waveform'
import { SoundLane } from './SoundLane'
import { WordsLane } from './WordsLane'
import { CommandPalette } from './CommandPalette'
import type { PaletteCommand } from './CommandPalette'
import { ExportDialog } from './ExportDialog'
import type { ExportItem } from './ExportDialog'
import { activeLook, applyLook, CAPTION_LOOKS } from './caption-looks'
import { SHORTCUTS } from './shortcuts'
import type { ImportedTrack } from './MusicMenu'
import { DEFAULT_MUSIC_VOLUME, effectiveMusic, kainoKey, musicGain, musicPosition, musicTrackKey, mixStorageKey } from './music'
import type { KainoCollection, Music, MusicTrack } from './music'
import { BookendsMenu } from './BookendsMenu'
import { effectiveBookends } from './bookends'
import { useSequenceCompositor } from './sequence-compositor'
import { activeTime, playbackClock, selectTimelineTime, useEditor, usePlaybackTime } from './editor-store'
import { isPlaybackShortcut, isTextEditing } from './playback-shortcut'
import type { Bookend, Bookends } from './bookends'

type VideoInfo = { path: string; name: string; duration: number; width: number; height: number; bytes: number }
type Panel = 'captions' | 'text' | 'music' | 'bookends' | 'frame' | null
type ExportSettings = { format: Format; framing: Framing; position: FramePosition; quality: Quality }
type Draft = {
  version: 2; source: VideoInfo; range: Range; clips: Clip[]; sections: Range[]
  keptRanges?: Range[]
  format: Format; quality: Quality; framing: Framing; positions: Record<Format, FramePosition>
  captions: Record<string, CaptionTrack | undefined>; captionStyle: CaptionStyle | null
  texts?: TextOverlay[]
  /** @deprecated v1.1.0 single-overlay draft format, read only for migration. */
  text?: TextOverlay | null
  music?: Music | null
  bookends?: Bookends
}
const DRAFT_KEY = 'minividcut.draft'
const AUTO_TITLES_KEY = 'minividcut.auto-titles'
const TITLE_DOWNLOAD_KEY = 'minividcut.title-download-allowed'
const EXPORT_FOLDER_KEY = 'minividcut.export-folder'

function readDraft(): Draft | null {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')
    if ((saved?.version !== 1 && saved?.version !== 2) || typeof saved?.source?.path !== 'string') return null
    const length = saved.source.duration
    const clips = Array.isArray(saved.clips)
      ? saved.clips.map((clip: Clip) => {
        const normalized = Number.isFinite(length) ? normalizeClip(clip, length) : clip
        return normalized ? migrateLegacyText(normalized) : null
      }).filter(Boolean)
      : []
    const keptRanges = Array.isArray(saved.keptRanges) && saved.keptRanges.length
      && saved.keptRanges.every((part: Range) => validRange(part, length))
      ? saved.keptRanges
      : [{ start: 0, end: length }]
    return { ...saved, version: 2, clips, keptRanges }
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
const musicTrackName = (track: MusicTrack) => track.kind === 'library' ? track.id : track.name
const PRESET_ICONS: Record<string, ReactNode> = {
  takeaways: <Lightbulb size={14} />, trending: <Flame size={14} />, motivational: <Rocket size={14} />,
  inspiring: <Sun size={14} />, funny: <Laugh size={14} />, story: <BookOpen size={14} />, tips: <ListChecks size={14} />,
  facts: <Zap size={14} />, emotional: <Heart size={14} />, quotes: <Quote size={14} />,
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

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
  // Follow the composited preview in source time so the playhead tracks the
  // picture instead of freezing at the last scrub position.
  const time = useEditor(selectTimelineTime)
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
  const updates = useAppUpdate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<Section | undefined>()
  /** The assistant whose sign-in stopped working during the last search. */
  const [agentIssue, setAgentIssue] = useState<AgentId | null>(null)
  const openAiSettings = () => { setSettingsSection('ai'); setSettingsOpen(true) }
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
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [timelineStart, setTimelineStart] = useState(0)
  const timelinePanned = useRef(false)
  const timelineDrag = useRef<{ x: number; start: number; width: number; moved: boolean } | null>(null)
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
  const [importedTracks, setImportedTracks] = useState<ImportedTrack[]>([])
  const [projectBookends, setProjectBookends] = useState<Bookends>({})
  const musicPlayer = useRef<HTMLAudioElement>(null)
  const setMusicPlayer = useCallback((audio: HTMLAudioElement | null) => {
    if (musicPlayer.current !== audio) musicPlayer.current?.pause()
    musicPlayer.current = audio
  }, [])
  const musicPaths = useRef(new Map<string, string>())
  const importMusicRef = useRef<(path: string, scope: 'project' | 'clip') => Promise<void>>(async () => {})
  const [previewMusic, setPreviewMusic] = useState<{ key: string; path: string } | null>(null)
  const [preferences, setPreferencesState] = useState(() => readPreferences(localStorage))
  const setPreferences = useCallback((next: Preferences) => {
    setPreferencesState(next)
    writePreferences(localStorage, next)
  }, [])
  const [draftFormat, setFormat] = useState<Format>(preferences.defaultFormat)
  const [draftQuality, setQuality] = useState<Quality>(preferences.defaultQuality)
  const [draftFraming, setFraming] = useState<Framing>('fill')
  const [positions, setPositions] = useState({ landscape: CENTER, portrait: CENTER })
  const [previewAspect, setPreviewAspect] = useState(0)
  const [panning, setPanning] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportChecked, setExportChecked] = useState<Set<number> | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
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
  const [exportFolder, setExportFolder] = useState(() => localStorage.getItem(EXPORT_FOLDER_KEY) ?? '')
  const [shortcuts, setShortcuts] = useState(false)
  const [splitMode, setSplitMode] = useState<'mark' | 'add'>('mark')
  const [sections, setSections] = useState<Range[]>([])
  const [keptRanges, setKeptRanges] = useState<Range[]>([])
  const [momentsOpen, setMomentsOpen] = useState(false)
  // The Captions panel has two tabs: the words themselves, and how they look.
  const [captionTab, setCaptionTab] = useState<'captions' | 'style'>('captions')
  // The tools column always shows one panel, chosen from the left rail.
  // The clips list lives in its own column on the right.
  const [panel, setPanelState] = useState<Exclude<Panel, null>>('captions')
  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) =>
    setPanelState(current => (typeof next === 'function' ? next(current) : next) ?? 'captions'), [])
  const [momentPicks, setMomentPicks] = useState<Set<string>>(new Set())
  const [momentLength, setMomentLength] = useState(30)
  const [momentCount, setMomentCount] = useState(5)
  const [momentQuery, setMomentQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<MenuState>(null)
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const [transcriptRevision, setTranscriptRevision] = useState(0)
  const [listening, setListening] = useState<number | null>(null)
  const askInput = useRef<HTMLInputElement>(null)
  const [findTab, setFindTab] = useState<'find' | 'time'>('find')
  // Quick searches live in a menu opened from the search box (or by typing /).
  const [presetMenu, setPresetMenu] = useState(false)
  const [presetFilter, setPresetFilter] = useState('')
  const presetMatches = useMemo(() => MOMENT_PRESETS.filter(preset =>
    !presetFilter || `${preset.label} ${preset.request}`.toLowerCase().includes(presetFilter)), [presetFilter])
  const choosePreset = (preset: (typeof MOMENT_PRESETS)[number]) => {
    const input = askInput.current
    if (input) {
      input.value = preset.request
      input.focus()
      input.setSelectionRange(preset.request.length, preset.request.length)
    }
    setPresetMenu(false)
    setPresetFilter('')
  }
  useEffect(() => {
    if (!presetMenu) return
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.('.find-ask-wrap')) setPresetMenu(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [presetMenu])
  useEffect(() => { if (momentsOpen) askInput.current?.focus() }, [momentsOpen])
  const [moments, setMoments] = useState<Moment[]>([])
  const [momentStatus, setMomentStatus] = useState('')
  const [momentRunning, setMomentRunning] = useState(false)
  const [momentProgress, setMomentProgress] = useState<number | null>(null)
  const [momentStopping, setMomentStopping] = useState(false)
  const momentJob = useRef<{ canceled: boolean; transcribing: boolean; agent: boolean; stop: () => void } | null>(null)
  const momentCache = useRef<{
    revision: number
    batches: { range: Range; cues: CaptionCue[] }[]
    matches: Map<string, MomentPick>
  }>({ revision: 0, batches: [], matches: new Map() })
  const playingMoment = useRef<Moment | null>(null)
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [clipActions, setClipActions] = useState<number | null>(null)
  const closeClipActions = useCallback(() => setClipActions(null), [])
  const renameClick = useRef<number | null>(null)
  const [clipFrames, setClipFrames] = useState<Record<number, string>>({})
  const captionsOpen = panel === 'captions'
  const setCaptionsOpen = (open: boolean) => setPanel(current => open ? 'captions' : current === 'captions' ? null : current)
  const [captionModel, setCaptionModel] = useState<CaptionModel | null>(null)
  const [captionProgress, setCaptionProgress] = useState<CaptionProgress | null>(null)
  const [captionStatus, setCaptionStatus] = useState<{ key: string; text: string } | null>(null)
  const [draftCaptions, setDraftCaptions] = useState<Record<string, CaptionTrack | undefined>>({})
  const [draftTexts, setDraftTexts] = useState<TextOverlay[]>([])
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null)
  const sharedCaptionStyle = useRef<CaptionStyle | null>(null)
  const captionJob = useRef<{ keys: Set<string>; cancelled: boolean } | null>(null)
  const listenJob = useRef<{ canceled: boolean } | null>(null)
  // The speech engine transcribes one range at a time. Captions, titles,
  // Find clips and the timeline transcript share it through this queue, one
  // short request each, so they take turns instead of refusing to start.
  const speechQueue = useRef<Promise<unknown>>(Promise.resolve())
  const speechOwner = useRef<string | null>(null)
  const withSpeech = useCallback(<T,>(owner: string, run: () => Promise<T>): Promise<T> => {
    const turn = speechQueue.current.then(async () => {
      speechOwner.current = owner
      try { return await run() } finally { speechOwner.current = null }
    })
    speechQueue.current = turn.catch(() => {})
    return turn
  }, [])
  const cancelSpeech = (owner: string) => {
    if (speechOwner.current === owner) void invoke('cancel_captions').catch(() => {})
  }
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
  const visibleTime = timelineWindow(duration, timelineZoom, timelineStart)
  wheelView.current = { duration, zoom: timelineZoom, start: visibleTime.start, span: visibleTime.span }
  const pct = (value: number) => visibleTime.span
    ? Math.max(0, Math.min(100, 100 * (value - visibleTime.start) / visibleTime.span)) : 0
  const [soundPeaks, setSoundPeaks] = useState<number[]>([])
  const sourcePath = source?.path
  useEffect(() => {
    setSoundPeaks([])
    if (!sourcePath || !duration) return
    let active = true
    const count = Math.min(4000, Math.max(1600, Math.ceil(duration * 4)))
    void invoke<number[]>('audio_peaks', { path: sourcePath, duration, count })
      .then(peaks => { if (active) setSoundPeaks(peaks) })
      .catch(() => {})
    return () => { active = false }
  }, [sourcePath, duration])
  const filmTiles = timelineFrames(duration, timelineZoom, visibleTime.start)
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
  const setPlaybackTime = useCallback((value: number) => {
    playbackClock.set(value)
    if (timelinePanned.current) return
    setTimelineStart(start => {
      const visible = timelineWindow(duration, timelineZoom, start)
      if (value >= visible.start - 0.000001 && value <= visible.end + 0.000001) return start
      return zoomTimeline(duration, timelineZoom, value)
    })
  }, [duration, timelineZoom])
  const zoomTimelineTo = (requested: number) => {
    const zoom = Math.max(1, Math.min(MAX_TIMELINE_ZOOM, requested))
    if (zoom === timelineZoom) return
    const now = playbackClock.get()
    const anchor = inView(now) ? now : (visibleTime.start + visibleTime.end) / 2
    setTimelineZoom(zoom)
    setTimelineStart(zoomTimeline(duration, zoom, anchor))
  }
  const revealTimelineTime = (point: number) => {
    timelinePanned.current = false
    if (!inView(point)) setTimelineStart(zoomTimeline(duration, timelineZoom, point))
  }

  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setTimeout(() => { void invoke('warm_encoders').catch(() => {}) }, 1500)
    return () => window.clearTimeout(timer)
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
  const selectedClipRef = useRef(selectedClip)
  selectedClipRef.current = selectedClip

  // Editing history is a snapshot of the timeline state, not of playback.
  // record() is called before a mutation so undo restores the previous state.
  type EditSnapshot = {
    range: Range; clips: Clip[]; sections: Range[]; keptRanges: Range[]
    draftCaptions: Record<string, CaptionTrack | undefined>
    draftTexts: TextOverlay[]
    selectedTextId: string | null
    selectedId: number | null; reviewIndex: number | null
  }
  const past = useRef<EditSnapshot[]>([])
  const future = useRef<EditSnapshot[]>([])
  const captionEditAt = useRef(0)
  const textEditAt = useRef(0)
  const [, setHistoryRevision] = useState(0)
  // Read through a ref so memoized callbacks always snapshot the latest state.
  const editorState = useRef({ range, clips, sections, keptRanges, draftCaptions, draftTexts, selectedTextId, selectedId, reviewIndex })
  editorState.current = { range, clips, sections, keptRanges, draftCaptions, draftTexts, selectedTextId, selectedId, reviewIndex }
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
  // Text uses its own window so a caption edit immediately before typing text
  // stays a separate undo step.
  const recordTextEdit = () => {
    const now = performance.now()
    if (now - textEditAt.current > 800) recordEdit()
    textEditAt.current = now
  }
  const applySnapshot = (state: EditSnapshot) => {
    setRange(state.range)
    setClips(state.clips)
    setSections(state.sections)
    setKeptRanges(state.keptRanges)
    setDraftCaptions(state.draftCaptions)
    setDraftTexts(state.draftTexts)
    setSelectedTextId(state.selectedTextId)
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
  const musicKey = musicTrack ? musicTrackKey(musicTrack) : ''
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

  useEffect(() => {
    void invoke<ImportedTrack[]>('local_imported_tracks')
      .then(setImportedTracks)
      .catch(() => {})
  }, [])

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
  // `mix` marks slider/toggle tweaks: they update the running preview live and
  // do not spam undo history or rebuild the composition.
  const changeMusic = (scope: 'project' | 'clip', music: Music | null | undefined, path?: string, mix = false) => {
    if (musicSourceRevision !== sourceRequest.current || exportLock.current || importLock.current) return
    if (!mix) recordRapidEdit()
    if (path && music) musicPaths.current.set(musicTrackKey(music.track), path)
    let resolved = music
    if (music && mix) {
      try {
        localStorage.setItem(mixStorageKey(music.track), JSON.stringify({ volume: music.volume, fade: music.fade }))
      } catch { /* storage may be unavailable */ }
    } else if (music) {
      try {
        const saved = localStorage.getItem(mixStorageKey(music.track))
        if (saved) {
          const persisted = JSON.parse(saved) as Partial<Music>
          resolved = {
            ...music,
            volume: typeof persisted.volume === 'number' ? persisted.volume : music.volume,
            fade: typeof persisted.fade === 'boolean' ? persisted.fade : music.fade,
          }
        }
      } catch { /* ignore malformed saved mix */ }
    }
    if (scope === 'project') setProjectMusic(resolved ?? null)
    else if (selectedClip) {
      setClips(items => items.map(clip => clip.id === selectedClip.id ? { ...clip, music: resolved } : clip))
    }
  }
  const changeMusicMix = (scope: 'project' | 'clip', music: Music | null | undefined) => {
    changeMusic(scope, music, undefined, true)
  }
  const importMusic = async (path: string, scope: 'project' | 'clip') => {
    const imported = await invoke<ImportedTrack>('import_music', { path })
    setImportedTracks(current => [imported, ...current.filter(track => track.id !== imported.id)])
    changeMusic(scope, {
      track: { kind: 'file', path: imported.path, name: imported.name },
      volume: DEFAULT_MUSIC_VOLUME,
    }, imported.path)
  }
  importMusicRef.current = importMusic
  const removeImportedMusic = (id: string) => {
    const imported = importedTracks.find(track => track.id === id)
    if (!imported) return
    if (activeMusic?.track.kind === 'file' && activeMusic.track.path === imported.path) {
      setNotice('Remove this music from the project before deleting the imported file.')
      return
    }
    void invoke('remove_imported_music', { id })
      .then(() => setImportedTracks(current => current.filter(track => track.id !== id)))
      .catch(error => setNotice(message(error)))
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
  // A selected clip owns its text blocks; `draftTexts` belong only to the
  // unsaved range. normalizeTexts also migrates v1.1.0 single-overlay drafts.
  const activeTexts = useMemo(() => selectedClip
    ? normalizeTexts(selectedClip.texts ?? selectedClip.text)
    : normalizeTexts(draftTexts),
  [selectedClip, draftTexts])
  const selectedText = activeTexts.find(text => text.id === selectedTextId) ?? null
  // One entry per saved block, plus the blocks in the unsaved range, so every
  // text the user added stays reachable from the Text panel.
  const textEntries = useMemo<TextEntry[]>(() => {
    const entries: TextEntry[] = []
    clips.forEach((clip, index) => {
      for (const item of normalizeTexts(clip.texts ?? clip.text)) entries.push({
        key: `${clip.id}:${item.id}`,
        label: clip.title || `Clip ${index + 1}`,
        time: `${stamp(clip.start, true)} – ${stamp(clip.end, true)}`,
        text: item.text.trim() || 'Empty text',
        clipId: clip.id, textId: item.id,
        active: selectedId === clip.id && selectedTextId === item.id,
      })
    })
    for (const item of normalizeTexts(draftTexts)) entries.push({
      key: `draft:${item.id}`,
      label: 'Unsaved range',
      time: `${stamp(range.start, true)} – ${stamp(range.end, true)}`,
      text: item.text.trim() || 'Empty text',
      clipId: null, textId: item.id,
      active: selectedId === null && selectedTextId === item.id,
    })
    return entries
  }, [clips, draftTexts, selectedId, selectedTextId, range.start, range.end])
  useEffect(() => {
    if (activeTexts.length && !activeTexts.some(text => text.id === selectedTextId)) {
      setSelectedTextId(activeTexts[0].id)
    } else if (!activeTexts.length && selectedTextId) setSelectedTextId(null)
  }, [activeTexts, selectedTextId])
  const bookends = useMemo(() => effectiveBookends(projectBookends, selectedClip?.bookends), [projectBookends, selectedClip?.bookends])
  const hasKeptEdit = keptRanges.length > 0 && (keptRanges.length > 1
    || keptRanges[0].start > 0.000001 || keptRanges[keptRanges.length - 1].end < duration - 0.000001)
  const deletedRanges = useMemo(() => {
    const gaps: Range[] = []
    let previous = 0
    for (const kept of keptRanges) {
      if (kept.start > previous + 0.000001) gaps.push({ start: previous, end: kept.start })
      previous = Math.max(previous, kept.end)
    }
    if (previous < duration - 0.000001) gaps.push({ start: previous, end: duration })
    return gaps
  }, [keptRanges, duration])
  const previewSegments = useMemo(() => hasKeptEdit ? keptRanges
    : selectedClip ? clipSegments(selectedClip) : [{ start: range.start, end: range.end }],
  [hasKeptEdit, keptRanges, selectedClip, range])
  const musicStructure = activeMusic ? musicTrackKey(activeMusic.track) : ''
  const sequenceKey = useMemo(() => source && (hasKeptEdit || bookends.intro || bookends.outro)
    ? JSON.stringify([musicSourceRevision, selectedId, previewSegments, format, framing, position, activeCaptions, musicStructure, bookends, musicCacheRevision])
    : '', [source, hasKeptEdit, musicSourceRevision, selectedId, previewSegments, format, framing, position, activeCaptions, musicStructure, bookends, musicCacheRevision])
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
  // Volume, fade and start offset apply to the running composite immediately.
  // They are deliberately absent from sequenceKey so the timeline keeps playing.
  useEffect(() => {
    if (!sequence.path) return
    sequence.player.current.updateMusic(activeMusic)
  }, [sequence.path, activeMusic?.volume, activeMusic?.start, activeMusic?.fade, musicPath])
  const captionsRunning = captionProgress !== null
  const hasDraftCaptions = Object.values(draftCaptions).some(track => track?.cues.length)

  const hasEdits = Boolean(source && (clips.length || sections.length || projectMusic || projectBookends.intro || projectBookends.outro || hasDraftCaptions || draftTexts.some(textActive) ||
    range.start !== 0 || range.end !== source.duration || draftFormat !== preferences.defaultFormat ||
    draftQuality !== preferences.defaultQuality || draftFraming !== 'fill' || Object.values(positions).some(
      position => position.x !== CENTER.x || position.y !== CENTER.y)))

  // Drafts can contain hundreds of thousands of caption characters. Serialize
  // them at most once per burst of edits instead of on every pointer move.
  const draftTimer = useRef<number | null>(null)
  const draftRef = useRef<Draft | null>(null)
  useEffect(() => {
    if (!source) return
    draftRef.current = {
      version: 2, source, range, clips, sections, keptRanges, format: draftFormat, quality: draftQuality,
      framing: draftFraming, positions, captions: draftCaptions, captionStyle: sharedCaptionStyle.current,
      texts: draftTexts,
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
  }, [source, range, clips, sections, keptRanges, draftFormat, draftQuality, draftFraming, positions, draftCaptions, draftTexts, projectMusic, projectBookends])
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
      setMomentPicks(new Set())
      setPanel(current => draft ? null : current)
      setExportOpen(false)
      setExportChecked(null)
      playingMoment.current = null
      setRecovery(null)
      if (captionJob.current && !captionJob.current.cancelled) captionJob.current.cancelled = true
      if (listenJob.current) listenJob.current.canceled = true
      if (speechOwner.current) void invoke('cancel_captions').catch(() => {})
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
      } else {
        setFormat(preferences.defaultFormat)
        setQuality(preferences.defaultQuality)
      }
      setRange(draft?.range ?? { start: 0, end: info.duration })
      setPlaybackTime(0)
      timelinePanned.current = false
      setTimelineZoom(1)
      setTimelineStart(0)
      setPlaying(false)
      setClips(draft?.clips ?? [])
      setDraftTexts(normalizeTexts(draft?.texts ?? draft?.text))
      setSelectedTextId(null)
      setProjectMusic(draft?.music ?? null)
      setProjectBookends(draft?.bookends ?? {})
      setClipActions(null)
      nextId.current = Math.max(0, ...(draft?.clips.map(clip => clip.id) ?? [])) + 1
      setSections(draft?.sections ?? [])
      setKeptRanges(draft?.keptRanges ?? [{ start: 0, end: info.duration }])
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
    } catch (error) {
      setNotice(message(error))
    } finally {
      importLock.current = false
      setLoading(false)
    }
  }, [recovery, hasEdits, setPlaybackTime, preferences.defaultFormat, preferences.defaultQuality])

  const clipStarts = [...new Set([...clips.flatMap(clip => clipSegments(clip).map(segment => segment.start)),
    ...moments.map(moment => moment.start)])].join(',')
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

  const chooseExportFolder = useCallback(async () => {
    if (fileDialog.current || exportLock.current) return
    if (!isTauri()) {
      setNotice('Open MiniVidCut as a desktop app to choose a folder.')
      return
    }
    fileDialog.current = true
    try {
      const folder = await open({ directory: true, title: 'Choose where to save exports',
        defaultPath: exportFolder || undefined })
      if (typeof folder === 'string' && folder) {
        setExportFolder(folder)
        localStorage.setItem(EXPORT_FOLDER_KEY, folder)
        setNotice('')
      }
    } catch (error) {
      setNotice(message(error))
    } finally {
      fileDialog.current = false
    }
  }, [exportFolder])

  const clearExportFolder = useCallback(() => {
    setExportFolder('')
    localStorage.removeItem(EXPORT_FOLDER_KEY)
  }, [])

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
        if (panel === 'music') {
          if (payload.paths.length !== 1) setNotice('Drop one audio file at a time.')
          else void importMusicRef.current(payload.paths[0], selectedClipRef.current ? 'clip' : 'project')
          return
        }
        if (payload.paths.length !== 1) setNotice('Drop one video at a time.')
        else void loadVideo(payload.paths[0])
      }
    })
    return () => {
      disposed = true
      void listener.then(unlisten => unlisten())
    }
  }, [loadVideo, panel])

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
    const next = Math.min(duration, Math.max(0, position))
    const player = video.current
    // A timeupdate queued before this seek can arrive afterwards with the old
    // time and pull the playhead back, making it oscillate left and right.
    ignoreTimeUpdateUntil.current = performance.now() + 120
    if (player && player.readyState > 0) player.currentTime = Math.min(next, player.duration)
    if (sequence.path) {
      // Keep the composite alive and move it to the clicked source position.
      // Tearing it down here made the next Play start again from zero.
      sequence.player.current.pause()
      sequence.player.current.seekSource(next)
    } else {
      stopSequence()
    }
    setPlaybackTime(next)
  }, [source, duration, sequence.path, stopSequence, setPlaybackTime])

  const refreshCaptionModel = useCallback(async () => {
    const info = await invoke<CaptionModel>('caption_model')
    setCaptionModel(info)
    return info
  }, [])

  // The assistant chosen in Settings → AI also writes titles, so one choice covers all AI work.
  const titleAgent = preferences.aiProvider !== 'local' && preferences.aiConsent[preferences.aiProvider] ? preferences.aiProvider : null

  const confirmTitleDownload = async (automatic: boolean, hasTranscript = false, searching = false) => {
    // With an assistant there is no language model to download, only the speech model.
    if (titleAgent && !searching) return confirmSpeechDownload(hasTranscript)
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

  // An installed assistant picks the clips, so only the speech model is needed.
  const confirmSpeechDownload = async (hasTranscript: boolean) => {
    const model = await refreshCaptionModel()
    if (model.installed || hasTranscript) return true
    return confirm(
      `Searching needs the ${Math.round(model.bytes / 1_000_000)} MB speech model to listen to your video. It downloads once and runs on this PC.`,
      { title: 'Download the speech model?', okLabel: 'Download' },
    )
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
    if (settingsOpen || !source || (!autoTitles && !requestedTitle) || !isTauri() || loading ||
      titleJob.current || importLock.current || titleError) return
    const revision = sourceRequest.current
    const clip = requestedTitle
      ? clips.find(clip => requestedTitle.sourceRevision === revision && clip.id === requestedTitle.id)
      : clips.find(clip => !clip.title && !clip.titleManuallyEdited && clip.id !== renaming && !clipLocked(clip.id) &&
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
        const cues = await withSpeech('title', () => invoke<CaptionCue[]>('generate_captions', {
          request: { path: source.path, range: { start: clip.start, end: clip.end }, duration: source.duration, allowDownload: true },
          progress,
        }))
        transcript = cues.map(cue => cue.text).join(' ').trim()
      }
      if (stale()) return
      if (!transcript) {
        if (requestedTitle) setNotice('No speech detected in this clip.')
        return
      }
      let title: string | undefined
      if (titleAgent) {
        setTitleProgress(`Asking ${agentMeta(titleAgent).name} for a title…`)
        // An answer in the wrong shape gets one more try.
        for (let attempt = 0; attempt < 2 && !title; attempt++) {
          const raw = await invoke<string>('run_agent_search', {
            provider: titleAgent, quality: preferences.aiQuality, task: 'titles', prompt: buildTitlePrompt(transcript),
            model: titleAgent === 'opencode' ? preferences.aiModel || null : null,
          })
          if (stale()) return
          try {
            title = parseAgentTitle(raw)
          } catch (error) {
            if (!(error instanceof AgentFormatError) || attempt) throw error
          }
        }
      } else {
        const progress = new Channel<string>()
        progress.onmessage = status => { if (!stale()) setTitleProgress(status) }
        title = await invoke<string>('generate_title', { transcript, progress })
      }
      if (stale() || !title) return
      const finalTitle = title
      setClips(items => items.map(item =>
        item.id === clip.id && item.start === clip.start && item.end === clip.end &&
        item.title === clip.title && item.titleManuallyEdited === clip.titleManuallyEdited
        ? { ...item, title: finalTitle, titleManuallyEdited: undefined } : item))
    }
    void generate().catch(error => {
      const text = titleAgent ? agentMessage(error, agentMeta(titleAgent).name) : message(error)
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
  }, [autoTitles, busy, captionsRunning, clips, loading, momentRunning, renaming, requestedTitle, settingsOpen, source, titleError, titleProgress, refreshCaptionModel, titleAgent, preferences.aiQuality, preferences.aiModel])

  const openCaptions = (key = captionKey) => {
    setRenaming(null)
    setCaptionsOpen(true)
    void refreshCaptionModel().catch(error => setCaptionStatus({ key, text: message(error) }))
  }

  const closeCaptions = useCallback(() => {
    setCaptionsOpen(false)
    requestAnimationFrame(() => document.getElementById('rail-captions')?.focus())
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

  // Text belongs to one video: a saved clip, or the current range. Every block
  // keeps its own id, so an edit or drag can never move a different layer.
  const updateTexts = useCallback((change: (items: TextOverlay[]) => TextOverlay[]) => {
    if (exportLock.current || importLock.current) return false
    recordTextEdit()
    if (selectedId === null) setDraftTexts(current => change(current))
    else setClips(items => items.map(clip => {
      if (clip.id !== selectedId) return clip
      // Migrates a v1.1.0 single-overlay clip on its first text edit.
      const { text: _legacy, ...rest } = clip
      void _legacy
      return { ...rest, texts: change(normalizeTexts(clip.texts ?? clip.text)) }
    }))
    return true
  }, [selectedId])

  const saveText = useCallback((overlay: TextOverlay) => {
    const next = normalizeText(overlay)
    updateTexts(items => items.map(item => item.id === next.id ? next : item))
  }, [updateTexts])

  const addText = useCallback(() => {
    const next = createTextOverlay()
    if (updateTexts(items => [...normalizeTexts(items), next].slice(0, TEXT_MAX_LAYERS))) setSelectedTextId(next.id)
  }, [updateTexts])

  const removeText = useCallback((id: string) => {
    if (updateTexts(items => items.filter(item => item.id !== id))) {
      setSelectedTextId(current => current === id ? null : current)
    }
  }, [updateTexts])

  const applyTextToAll = useCallback(() => {
    if (exportLock.current || importLock.current || !selectedText || !clips.length) return
    recordEdit()
    const updated = spreadTextToTargets(
      [...clips.map(clip => normalizeTexts(clip.texts ?? clip.text)), normalizeTexts(draftTexts)],
      selectedText,
    )
    setClips(items => items.map((clip, index) => {
      const { text: _legacy, ...rest } = clip
      void _legacy
      return { ...rest, texts: updated[index] }
    }))
    setDraftTexts(updated[clips.length])
    setNotice(`Applied “${selectedText.text.trim() || 'text'}” to all ${clips.length} clip${clips.length === 1 ? '' : 's'}.`)
  }, [clips, draftTexts, selectedText])

  const applyCaptionStyle = useCallback((style: CaptionStyle) => {
    if (exportLock.current || importLock.current) return false
    recordEdit()
    sharedCaptionStyle.current = style
    setClips(items => items.map(clip => restyleCaptionedClip(clip, style)))
    setDraftCaptions(items => Object.fromEntries(Object.entries(items).map(([key, track]) =>
      [key, track && { ...track, style }])))
    return true
  }, [])

  const runCaptionJob = async (targets: { key: string; range: Range; clip?: Clip; track?: CaptionTrack }[], action: 'editor' | 'clip' | 'stack') => {
    if (!source || !targets.length || importLock.current) return
    if (!targets.every(target => validRange(target.range, duration))) return
    // A second caption request waits for the first instead of being ignored.
    const waitRevision = sourceRequest.current
    while (captionJob.current) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (waitRevision !== sourceRequest.current) return
    }
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
          const cues = await withSpeech('captions', () => stale() ? Promise.resolve([] as CaptionCue[])
            : invoke<CaptionCue[]>('generate_captions', {
              request: { path: source.path, range: { start, end }, duration: source.duration, allowDownload: !model.installed },
              progress,
            }))
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
    if (speechOwner.current === 'captions') void invoke('cancel_captions').catch(() => {})
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
      startAtSource: activeTime(),
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
    if (job.transcribing) cancelSpeech('moments')
    if (job.agent) void invoke('cancel_agent_job').catch(() => {})
    // Wake any step still waiting in line for the speech engine.
    job.stop()
  }

  const clearMoments = () => {
    if (momentRunning) return
    setMoments([])
    setMomentPicks(new Set())
    setMomentStatus('')
    setMomentProgress(null)
    playingMoment.current = null
    // Forget earlier AI choices so the next Find is a fresh pass. Transcripts
    // stay cached because listening to the video again is slow and unnecessary.
    if (momentCache.current.revision === sourceRequest.current) momentCache.current.matches.clear()
  }

  const searchMoments = async (request: string, maximum: number, maxResults: number) => {
    if (!source || momentJob.current || importLock.current) return
    const limit = momentLimit(request, maximum)
    const topic = momentRequest(request)
    // An assistant is used only after the user agreed to send it transcript text.
    const agentId = preferences.aiProvider !== 'local' && preferences.aiConsent[preferences.aiProvider] ? preferences.aiProvider : null
    const agentName = agentId ? agentMeta(agentId).name : ''
    setAgentIssue(null)
    setMomentQuery(request)
    if (!Number.isFinite(limit) || limit < 0.05 || limit > 120 ||
      !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_CLIPS) {
      setMomentStatus('Choose a valid clip length and number of suggestions.')
      return
    }
    const revision = sourceRequest.current
    let stopNow = () => {}
    const stopped = new Promise<void>(resolve => { stopNow = resolve })
    const job = { canceled: false, transcribing: false, agent: false, stop: stopNow }
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
    // Confident picks (the model chose the same excerpt both ways) come
    // first; likely picks fill the list so a search never comes back empty-handed
    // just because the small model hesitated.
    const found: Moment[] = []
    const likely: Moment[] = []
    let scanned = 0
    const enough = () => found.length >= maxResults || (found.length + likely.length >= maxResults && scanned >= 4)
    const leftovers: Moment[] = []
    const askGroup = async (group: Moment[]) => {
      const excerpts = group.map(item => item.text)
      const key = JSON.stringify([topic, excerpts])
      let match = matches.get(key)
      if (match === undefined) {
        const progress = new Channel<string>()
        progress.onmessage = () => { if (active()) setMomentStatus('Preparing Smart Split for first use…') }
        match = await invoke<MomentPick>('select_moment', { request: topic, excerpts, progress })
        if (matches.size >= 500) matches.clear()
        matches.set(key, match)
      }
      const picked = match.index === null ? undefined : group[match.index]
      leftovers.push(...group.filter(item => item !== picked))
      // Stretched candidates can span a batch boundary, so keep a later
      // pick from repeating footage already suggested from an earlier one.
      if (active() && picked && ![...found, ...likely].some(item => rangesOverlap(item, picked))) {
        ;(match.confident ? found : likely).push(picked)
        publish()
      }
    }
    // With an installed assistant, the video is transcribed in chunks and each
    // finished chunk is handed to the assistant in the background while the next
    // one is still being transcribed. Picks merge into the list as they arrive.
    let agentError: unknown = null
    let thinking = false
    let pending: CaptionCue[] = []
    let chunkStart = 0
    let fresh = false
    let chain: Promise<void> = Promise.resolve()
    const picked: Moment[] = []
    const agentLine = (where: string) =>
      `${where} · ${Math.min(maxResults, found.length)} of ${maxResults} found${thinking ? ` · ${agentName} is picking` : ''}`
    const askChunk = async (id: AgentId, cues: CaptionCue[]) => {
      if (!active() || agentError !== null) return
      thinking = true
      job.agent = true
      try {
        for (const part of windowCues(cues)) {
          if (!active()) return
          const prompt = buildAgentPrompt({ cues: part, request: topic, limit, count: maxResults })
          let clips: Moment[] | undefined
          // An assistant that answers in the wrong shape gets one more try.
          for (let attempt = 0; attempt < 2 && !clips; attempt++) {
            const raw = await invoke<string>('run_agent_search', {
              provider: id, quality: preferences.aiQuality, model: id === 'opencode' ? preferences.aiModel || null : null, prompt, task: 'clips',
            })
            if (!active()) return
            try {
              clips = parseAgentClips(raw, part, limit, maxResults)
            } catch (error) {
              if (!(error instanceof AgentFormatError) || attempt) throw error
            }
          }
          picked.push(...(clips ?? []))
        }
        if (!active()) return
        found.length = 0
        found.push(...pickBest(picked, maxResults))
        publish()
      } catch (error) {
        agentError ??= error
      } finally {
        thinking = false
        job.agent = false
      }
    }
    // Calls take turns, so the assistant works on one chunk at a time.
    const dispatchChunk = (id: AgentId, until: number) => {
      const cues = pending
      // Keep the last minute so a thought on the boundary is seen whole next time.
      pending = pending.filter(cue => cue.start >= until - 60)
      chunkStart = until
      fresh = false
      chain = chain.then(() => askChunk(id, cues))
    }
    const reportAgentError = (error: unknown) => {
      const text = typeof error === 'string' ? error : ''
      if (text === AGENT_CANCELED) return
      if (text === AGENT_SIGNED_OUT && agentId) {
        setAgentIssue(agentId)
        setMomentStatus(`${agentName} needs you to sign in again.`)
      } else {
        setMomentStatus(`${agentName} couldn’t finish. ${agentMessage(error, agentName)} Try again, or switch to This device in Settings.`)
      }
    }
    const publish = () => {
      const shown = [...found, ...likely].slice(0, maxResults)
      setMoments(shown)
      setMomentPicks(new Set(shown.map(item => `${item.start}:${item.end}`)))
    }
    try {
      if (!active()) return
      const missing = missingTranscriptRanges(videoRange, [...known, ...cache].map(batch => batch.range))
      if (agentId ? !await confirmSpeechDownload(!missing.length) : !await confirmTitleDownload(false, !missing.length, true)) return
      if (!active()) return
      setMoments([])
      setMomentPicks(new Set())
      for (let start = 0; start < source.duration && active() && agentError === null && (agentId ? true : !enough()); start += MOMENT_BATCH_SECONDS) {
        const batch = { start, end: Math.min(start + MOMENT_BATCH_SECONDS, source.duration) }
        const status = () => agentId
          ? agentLine(`Reading ${stamp(batch.start)}–${stamp(batch.end)} of ${stamp(source.duration)}`)
          : `Searching ${stamp(batch.start)}–${stamp(batch.end)} · ${Math.min(maxResults, found.length + likely.length)} of ${maxResults} found`
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
          if (!active()) break
          job.transcribing = true
          setMomentStatus(agentId ? agentLine(`Listening ${stamp(gap.start)}–${stamp(gap.end)}`) : 'Listening for moments in this part of the video…')
          try {
            const progress = new Channel<CaptionProgress>()
            progress.onmessage = update => {
              if (!active()) return
              if (update.stage === 'downloading') setMomentStatus(`Downloading speech tools · ${Math.round(update.fraction * 100)}%`)
              else if (update.stage === 'transcribing') {
                setMomentStatus(agentId ? agentLine(`Listening ${stamp(gap.start)}–${stamp(gap.end)}`) : 'Listening for moments in this part of the video…')
                const scanned = gap.start - batch.start + (gap.end - gap.start) * update.fraction
                setMomentProgress(previous => Math.max(previous ?? 0, (batch.start + scanned * (agentId ? 1 : 0.8)) / source.duration))
              }
            }
            const result = await Promise.race([
              withSpeech('moments', () => active()
                ? invoke<CaptionCue[]>('generate_captions', {
                  request: { path: source.path, range: gap, duration: source.duration, allowDownload: true }, progress,
                })
                : Promise.resolve([] as CaptionCue[])),
              stopped.then(() => [] as CaptionCue[]),
            ])
            if (!active()) break
            const generated = result.map(cue => offsetCaption(cue, gap.start))
            cache.push({ range: gap, cues: generated })
            setTranscriptRevision(revision => revision + 1)
            includeGenerated(generated)
          } finally {
            job.transcribing = false
          }
        }
        if (!active()) break
        setMomentStatus(status())
        const unique = [...new Map(cues.map(cue => [`${cue.start}:${cue.end}`, cue])).values()].sort((a, b) => a.start - b.start)
        if (agentId) {
          if (unique.length) { pending.push(...unique); fresh = true }
          if (fresh && (batch.end - chunkStart >= AGENT_CHUNK_SECONDS || batch.end >= source.duration)) dispatchChunk(agentId, batch.end)
          continue
        }
        const candidates = momentCandidates(unique, { ...batch, end: Math.min(source.duration, batch.end + limit) }, limit)
          .filter(candidate => momentWorthy(candidate.text))
        for (let index = 0; index < candidates.length && active() && found.length < maxResults; index += 4) {
          const group = candidates.slice(index, index + 4)
          await askGroup(group)
          if (active()) {
            setMomentStatus(status())
            setMomentProgress((batch.start + (batch.end - batch.start) * (0.8 + 0.2 * Math.min(1, (index + 4) / candidates.length))) / source.duration)
          }
        }
        scanned++
      }
      if (agentId) {
        if (fresh && active() && agentError === null) dispatchChunk(agentId, source.duration)
        setMomentProgress(1)
        setMomentStatus(agentLine('Finishing'))
        await chain
      }
      // The model picks one excerpt per group of four, so a short video can
      // run out of groups before reaching the requested count. Ask again about
      // the candidates it passed over until the count is met or none are left.
      for (let pass = 0; pass < 3 && !agentId && active() && found.length + likely.length < maxResults; pass++) {
        const remaining = leftovers.filter(item => ![...found, ...likely].some(chosen => rangesOverlap(chosen, item)))
        leftovers.length = 0
        if (remaining.length < 2) break
        setMomentStatus(`Looking for more · ${found.length + likely.length} of ${maxResults} found`)
        for (let index = 0; index < remaining.length && active() && found.length + likely.length < maxResults; index += 4) {
          await askGroup(remaining.slice(index, index + 4))
        }
      }
      const total = Math.min(maxResults, found.length + likely.length)
      if (agentError !== null) { if (active()) reportAgentError(agentError) }
      else if (active()) setMomentStatus(total ? `Review ${total} suggested ${total === 1 ? 'moment' : 'moments'}.` : 'No matching moments found. Try another quick search or a shorter description.')
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

  // Find clips no longer waits for captions or titles: the speech engine
  // queue lets them all run side by side.
  const requestSearch = (request: string) => {
    void searchMoments(request, momentLength, momentCount)
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
    if (clips.length >= MAX_CLIPS) {
      setNotice(`A batch can contain up to ${MAX_CLIPS} clips.`)
      return
    }
    recordEdit()
    const clip = { start: range.start, end: range.end, segments: [{ ...range }], id: nextId.current++,
      captions: activeCaptions, texts: activeTexts.length ? activeTexts : undefined }
    setClips(items => [...items, clip])
    // The range's text now belongs to the saved clip; do not leak it onto the
    // next clip edited from an unrelated range.
    setDraftTexts([])
    setSelectedTextId(null)
    setSelectedId(null)
    setReviewIndex(null)
    setNotice('')
  }

  // Explicit update lives in the clip's actions menu, so the main commit
  // button always adds a new clip and never silently overwrites one.
  const updateClip = (clip: Clip) => {
    if (clipLocked(clip.id) || !validRange(range, duration)) return
    recordEdit()
    setClips(items => items.map(item => item.id === clip.id ? {
      ...item, start: range.start, end: range.end, segments: [{ ...range }], captions: captionSlice(item.captions, range),
    } : item))
    setSelectedId(null)
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
    setMomentsOpen(false)
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
    setMomentsOpen(false)
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

  const jumpToText = (clipId: number | null, textId: string) => {
    if (clipId !== null) {
      const clip = clips.find(item => item.id === clipId)
      if (!clip) return
      selectClip(clip)
    } else {
      video.current?.pause()
      setSelectedId(null)
      setReviewIndex(null)
    }
    setSelectedTextId(textId)
  }

  const captionClip = (clip: Clip) => {
    selectClip(clip)
    openCaptions(`clip-${clip.id}`)
    if (clipsNeedingCaptions([clip]).length) {
      void runCaptionJob([{ key: `clip-${clip.id}`, range: clip, clip, track: clip.captions }], 'clip')
    }
  }

  const captionStack = () => {
    const missing = clipsNeedingCaptions(clips)
    if (!missing.length) return
    selectClip(missing[0])
    openCaptions(`clip-${missing[0].id}`)
    void runCaptionJob(missing.map(clip => ({ key: `clip-${clip.id}`, range: clip, clip, track: clip.captions })), 'stack')
  }

  const trimSection = () => {
    if (!canTrim) return
    recordEdit()
    const next = deleteFromRanges(keptRanges, range)
    const removed = Math.max(0, range.end - range.start)
    const total = keptDuration(next)
    setKeptRanges(next)
    setSelectedId(null)
    setReviewIndex(null)
    setRange({ start: 0, end: total })
    setDraftCaptions(current => {
      const updated = { ...current }
      for (const key of Object.keys(updated)) if (key.startsWith('section-')) delete updated[key]
      return updated
    })
    setNotice('')
    video.current?.pause()
    seek(0)
    setEditStatus(next.length
      ? `Removed ${stamp(removed)}. ${stamp(total)} of video kept.`
      : 'Removed the selection. Nothing left to keep.')
  }

  const renameClip = (id: number, title: string) => {
    if (clipLocked(id)) return
    const cleaned = title.trim()
    recordEdit()
    setClips(items => items.map(clip => clip.id === id
      ? { ...clip, title: cleaned || undefined, titleManuallyEdited: true } : clip))
    setRenaming(null)
  }

  const startClipEdgeDrag = (event: ReactPointerEvent, clip: Clip, side: 'start' | 'end') => {
    if (!source || loading || selectedLocked || busy || event.button !== 0 || !track.current) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    const rect = track.current.getBoundingClientRect()
    const pointer = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width)
    clipEdgeDrag.current = { clip, side, axisPointer: pointer, value: clip[side], recorded: false }
    seek(clip[side])
  }

  const moveClipEdgeDrag = (event: ReactPointerEvent) => {
    const drag = clipEdgeDrag.current
    if (!drag || busy || !track.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = track.current.getBoundingClientRect()
    const axis = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width)
    const raw = drag.value + axis - drag.axisPointer
    const value = Math.max(0, Math.min(duration, raw))
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

  const exportVideos = async (only?: Clip[]) => {
    if (!source || exportLock.current || importLock.current || fileDialog.current) return
    if (!clips.length && sections.length) return
    // A ripple-deleted video is one edited timeline, not a set of separate
    // clips. Export it as a single file containing every kept range.
    const editedClip: Clip = {
      id: 0,
      start: 0,
      end: keptDuration(keptRanges),
      segments: keptRanges.map(part => ({ ...part })),
      title: 'Edited video',
      captions: captionsForKept(draftCaptions.range, keptRanges),
      texts: activeTexts.length ? activeTexts : undefined,
    }
    const batch: Clip[] = hasKeptEdit ? [editedClip]
      : only?.length ? only : clips.length ? clips : [{ ...range, id: 0, captions: activeCaptions, texts: activeTexts.length ? activeTexts : undefined }]
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
      const folder = exportFolder || await open({ directory: true, title: 'Choose where to save your clips' })
      if (!folder) return
      started = true
      // Each source segment becomes one FFmpeg file, but the UI keeps one
      // status and one lock per clip (see groupExportStates).
      const units: ExportUnit[] = hasKeptEdit
        ? [{ clip: batch[0], segment: { start: 0, end: batch[0].end }, first: true, last: true }]
        : exportUnits(batch)
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
      const hasCaptionArtwork = batch.some(clip => clip.captions?.cues.some(cue => cue.text.trim())
        || normalizeTexts(clip.texts ?? clip.text).some(textActive))
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
        segments?: Range[]
      }[] = []
      const musicOffsets = new Map<number, number>()
      const OVERLAY_CONCURRENCY = 3
      for (let index = 0; index < units.length; index += OVERLAY_CONCURRENCY) {
        if (cancelRequested.current) break
        const chunk = units.slice(index, index + OVERLAY_CONCURRENCY)
        const rendered = await Promise.all(chunk.map(async unit => {
          const captions = captionSlice(unit.clip.captions, unit.segment, true)
          const texts = normalizeTexts(unit.clip.texts ?? unit.clip.text)
          if (!captions && !texts.some(textActive)) return undefined
          return await prepareCaptionOverlay(captions, texts, options.format,
            unit.segment.end - unit.segment.start, () => cancelRequested.current) || undefined
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
            title: unit.first ? exportFileName(preferences.fileNameParts, {
              title: unit.clip.title, video: baseName,
              number: Math.max(0, clips.findIndex(item => item.id === unit.clip.id)) + 1,
            }) : undefined,
            captionOverlay,
            music: music ? { ...music, start: musicOffset + (music.start ?? 0) } : null,
            bookends: {
              intro: unit.first ? ends.intro : null,
              outro: unit.last ? ends.outro : null,
            },
            segments: hasKeptEdit ? keptRanges.map(part => ({ ...part })) : undefined,
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
      if (preferences.openFolderAfterExport && states.some(state => state.status === 'saved')) {
        void invoke('open_export_folder').catch(() => {})
      }
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
    undoEdit, redoEdit, paletteOpen, exportOpen,
  })
  shortcutState.current = {
    captionsOpen, settingsOpen, shortcuts, source, loading, timelineZoom,
    closeCaptions, chooseVideo, zoomTimelineTo, editBoundary, seekPlayback, addClip, togglePlay,
    undoEdit, redoEdit, paletteOpen, exportOpen,
  }
  useEffect(() => {
    const shortcutsHandler = (event: KeyboardEvent) => {
      const state = shortcutState.current
      const key = event.key.toLowerCase()
      const target = event.target instanceof Element ? event.target : null
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'k') {
        event.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (document.querySelector('.settings-page:not([hidden])') || state.paletteOpen || state.exportOpen) return

      if (event.key === 'Escape') {
        if (state.captionsOpen && target?.closest('#caption-editor') && !target.closest('input, select, textarea')) state.closeCaptions()
        setShortcuts(false)
        setMomentsOpen(false)
        if (!target?.closest('input, select, textarea')) setPanel(null)
        return
      }
      if (key === '/' && !isTextEditing(target) && state.source) {
        event.preventDefault()
        setMomentsOpen(true)
        askInput.current?.focus()
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'e') {
        event.preventDefault()
        if (state.source) setExportOpen(true)
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
    }
    const playbackShortcut = (event: KeyboardEvent) => {
      const state = shortcutState.current
      if (!isPlaybackShortcut(event,
        { hasSource: Boolean(state.source), settingsOpen: state.settingsOpen, shortcutsOpen: state.shortcuts || state.paletteOpen || state.exportOpen },
        event.target instanceof Element ? event.target : null,
        selector => document.querySelector(selector))) return
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
    const pointer = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left - offset) / rect.width)
    const drag = edge ? trimDrag.current : null
    const raw = pointer - (drag?.offset ?? 0)
    const time = Math.max(0, Math.min(duration, raw))
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
      const pointer = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left) / rect.width)
      trimDrag.current = { range, offset: pointer - range[edge] }
      seek(range[edge])
    } else scrub(event)
  }

  const startPlayheadDrag = (event: ReactPointerEvent) => {
    if (!track.current || loading || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
    if (sequence.path) sequence.player.current.pause()
    timelinePanned.current = true
    const rect = track.current.getBoundingClientRect()
    playheadOffset.current = event.clientX - rect.left - pct(playbackClock.get()) * rect.width / 100
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
    setTimelineStart(panTimeline(duration, timelineZoom, drag.start, delta / drag.width))
  }

  const finishTrackDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = timelineDrag.current
    if (drag && !drag.moved && event.currentTarget.hasPointerCapture(event.pointerId)) {
      video.current?.pause()
      const rect = event.currentTarget.getBoundingClientRect()
      seek(timelineTime(drag.start, visibleTime.span, (drag.x - rect.left) / rect.width))
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
  const canTrim = !trimDisabled && canSaveRange && !captionsRunning && !captionJob.current
    && (range.start > 0 || range.end < duration)
  const batchCount = clips.length || (hasSource && !sections.length ? 1 : 0)
  const summary = exportBatch && summarizeExport(exportBatch.weights, exportBatch.states)
  const singleExport = busy ? exportBatch?.ranges.find(clip => clip.id === 0) : undefined
  const displayedClips = singleExport ? [singleExport, ...clips] : clips
  const captionLabel = selectedClip ? selectedClip.title || `Clip ${String(clips.indexOf(selectedClip) + 1).padStart(2, '0')}`
    : reviewed ? `Section ${(reviewIndex ?? 0) + 1}` : 'Current range'
  const showCaptionEditor = captionsOpen && !trimDisabled && canSaveRange
  const togglePanel = (next: Exclude<Panel, null>) => {
    setMomentsOpen(false)
    if (next === 'captions' && panel !== 'captions') {
      openCaptions()
      return
    }
    setPanel(next)
  }
  // Panels stay put; closing one just returns focus to its rail button.
  const closePanel = (closed: Exclude<Panel, null>) => {
    requestAnimationFrame(() => document.getElementById(`rail-${closed}`)?.focus())
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

  // Settings → AI: caption each new clip in the background once the speech
  // model is on this device. Each clip is attempted once per source.
  const autoCaptioned = useRef(new Set<string>())
  useEffect(() => {
    if (!preferences.autoCaption || !source || settingsOpen || loading || captionsRunning || !captionModel?.installed ||
      captionJob.current || importLock.current) return
    const revision = sourceRequest.current
    const clip = clipsNeedingCaptions(clips).find(item => !clipLocked(item.id) && !autoCaptioned.current.has(`${revision}:${item.id}:${item.start}:${item.end}`))
    if (!clip) return
    autoCaptioned.current.add(`${revision}:${clip.id}:${clip.start}:${clip.end}`)
    void runCaptionJob([{ key: `clip-${clip.id}`, range: clip, clip, track: clip.captions }], 'clip')
  })

  // Settings → Updates: start downloading a new version in the background.
  // Installing still waits for the restart prompt.
  const autoDownloaded = useRef('')
  useEffect(() => {
    if (!preferences.backgroundUpdates || updates.status.phase !== 'available') return
    const version = updates.status.info.version
    if (autoDownloaded.current === version) return
    autoDownloaded.current = version
    void updates.download(true)
  }, [preferences.backgroundUpdates, updates])

  // Every transcribed word we know about, for the timeline's Words lane.
  // The speech engine's own transcript can run to tens of thousands of cues, and
  // it only changes when more of the video has been heard. Keep it sorted once so
  // editing a clip (which changes `clips` on every pointer move while dragging an
  // edge) only has to fold the small, user-edited part into it.
  const heardCues = useMemo(() => {
    void transcriptRevision
    void source
    if (momentCache.current.revision !== sourceRequest.current) return []
    const heard = new Map<string, CaptionCue>()
    for (const batch of momentCache.current.batches) {
      for (const cue of batch.cues) if (cue.text.trim()) heard.set(`${cue.start}:${cue.end}`, cue)
    }
    return [...heard.values()].sort((a, b) => a.start - b.start)
  }, [transcriptRevision, source])
  const transcript = useMemo(() => {
    const edited = new Map<string, CaptionCue>()
    const add = (items?: CaptionCue[]) => items?.forEach(cue => {
      if (cue.text.trim()) edited.set(`${cue.start}:${cue.end}`, cue)
    })
    Object.values(draftCaptions).forEach(track => add(track?.cues))
    clips.forEach(clip => add(clip.captions?.cues))
    if (!edited.size) return heardCues
    // Edited captions win over the same words heard by the engine.
    const merged = heardCues.filter(cue => !edited.has(`${cue.start}:${cue.end}`))
    merged.push(...edited.values())
    return merged.sort((a, b) => a.start - b.start)
  }, [clips, draftCaptions, heardCues])

  // Listen to the parts of the video without a transcript so the Words lane
  // can show what is said everywhere. Reuses the Smart Split transcript cache.
  const listenToVideo = async () => {
    if (!source || listenJob.current || importLock.current) return
    const revision = sourceRequest.current
    if (momentCache.current.revision !== revision) momentCache.current = { revision, batches: [], matches: new Map() }
    const known = transcript.map(cue => ({ start: cue.start, end: cue.end }))
    const missing = missingTranscriptRanges({ start: 0, end: source.duration },
      [...known, ...momentCache.current.batches.map(batch => batch.range)])
    if (!missing.length) return
    const model = await refreshCaptionModel()
    if (!model.installed && !await confirm(
      `Download the ${Math.round(model.bytes / 1_000_000)} MB speech model to show the words on the timeline?`,
      { title: 'Show words on the timeline?', okLabel: 'Download & listen' })) return
    const job = { canceled: false }
    listenJob.current = job
    const total = missing.reduce((sum, gap) => sum + gap.end - gap.start, 0)
    let done = 0
    setListening(0)
    try {
      for (const gap of missing) {
        if (job.canceled || sourceRequest.current !== revision) break
        const progress = new Channel<CaptionProgress>()
        progress.onmessage = update => {
          if (update.stage === 'transcribing') setListening((done + (gap.end - gap.start) * update.fraction) / total)
        }
        const result = await withSpeech('listen', () => job.canceled || sourceRequest.current !== revision
          ? Promise.resolve([] as CaptionCue[])
          : invoke<CaptionCue[]>('generate_captions', {
            request: { path: source.path, range: gap, duration: source.duration, allowDownload: true }, progress,
          }))
        if (job.canceled || sourceRequest.current !== revision) break
        momentCache.current.batches.push({ range: gap, cues: result.map(cue => offsetCaption(cue, gap.start)) })
        setTranscriptRevision(value => value + 1)
        done += gap.end - gap.start
      }
    } catch (error) {
      if (sourceRequest.current === revision && !job.canceled) setNotice(message(error))
    } finally {
      if (listenJob.current === job) listenJob.current = null
      setListening(null)
      void refreshCaptionModel().catch(() => {})
    }
  }

  // A stable handle on the latest listenToVideo, so the memoized Words lane is
  // not re-rendered just because this component rebuilt its closure.
  const listenToVideoRef = useRef(listenToVideo)
  listenToVideoRef.current = listenToVideo
  const listenToVideoStable = useCallback(() => void listenToVideoRef.current(), [])

  const momentKey = (moment: Range) => `${moment.start}:${moment.end}`
  const addPickedMoments = () => {
    const picked = moments.filter(moment => momentPicks.has(momentKey(moment))
      && !clips.some(clip => clip.start === moment.start && clip.end === moment.end))
    for (const moment of picked) addMoment(moment)
    setMomentPicks(new Set())
    if (picked.length) {
      setEditStatus(`Added ${picked.length} ${picked.length === 1 ? 'clip' : 'clips'}.`)
      setMomentsOpen(false)
    }
  }

  // Previous and next saved clips around the selection (or the playhead), shown
  // faded beside the preview so the stack of shorts stays in view.
  const ordered = useMemo(() => [...clips].sort((a, b) => a.start - b.start || a.id - b.id), [clips])
  // Opening Captions with nothing selected shows the first clip's captions. This runs when
  // the panel opens or clips first appear, not on every change, so you can still deselect.
  useEffect(() => {
    if (panel === 'captions' && selectedId === null && !reviewed && ordered.length && !disabled) selectClip(ordered[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, ordered.length > 0])
  const neighborAt = selectedClip ? ordered.indexOf(selectedClip) : ordered.findIndex(clip => clip.start > range.start)
  const previousClip = selectedClip ? ordered[neighborAt - 1] : neighborAt < 0 ? ordered[ordered.length - 1] : ordered[neighborAt - 1]
  const nextClip = selectedClip ? ordered[neighborAt + 1] : neighborAt < 0 ? undefined : ordered[neighborAt]
  const clipNumber = (clip: Clip) => clips.indexOf(clip) + 1
  const clipName = (clip: Clip) => clip.title || `Clip ${String(clipNumber(clip)).padStart(2, '0')}`

  // Export window contents: one card per clip, or one for the edited video.
  const exportItems: ExportItem[] = (() => {
    const states = new Map(exportBatch?.ranges.map((clip, index) => [clip.id, exportBatch.states[index]]))
    if (hasKeptEdit || !clips.length) {
      const length = hasKeptEdit ? keptDuration(keptRanges) : Math.max(0, range.end - range.start)
      return hasSource ? [{ id: 0, title: hasKeptEdit ? 'Edited video' : selectedClip ? clipName(selectedClip) : 'Current range', number: 1,
        duration: length, thumbnail: clipFrames[hasKeptEdit ? keptRanges[0]?.start ?? 0 : range.start],
        needsCaptions: !activeCaptions?.cues.length, state: states.get(0) }] : []
    }
    return clips.map((clip, index) => ({
      id: clip.id, title: clipName(clip), number: index + 1,
      duration: clipSegments(clip).reduce((sum, part) => sum + part.end - part.start, 0),
      thumbnail: clipFrames[clip.start], needsCaptions: clipsNeedingCaptions([clip]).length > 0,
      state: states.get(clip.id),
    }))
  })()
  const checkedExports = exportChecked ?? new Set(exportItems.map(item => item.id))
  const openExport = () => {
    if (!busy) setExportChecked(null)
    setPanel(null)
    setMomentsOpen(false)
    setExportOpen(true)
  }
  const startExport = () => {
    const chosen = exportItems.filter(item => checkedExports.has(item.id))
    if (!chosen.length) return
    const only = hasKeptEdit || !clips.length ? undefined : clips.filter(clip => checkedExports.has(clip.id))
    void exportVideos(only)
  }

  const toggleAutoCaptionPreference = () => setPreferences({ ...preferences, autoCaption: !preferences.autoCaption })

  const baseName = source ? source.name.replace(/\.[^.]+$/, '') : ''
  const totalClipSeconds = clips.reduce((sum, clip) => sum + clipSegments(clip).reduce((part, segment) => part + segment.end - segment.start, 0), 0)
  const captionStyle = activeCaptions?.style
  const currentLook = captionStyle ? activeLook(captionStyle) : undefined
  const captionScale = Math.round((captionStyle?.scale ?? (captionStyle?.size === 'small' ? 0.81 : captionStyle?.size === 'large' ? 1.25 : 1)) * 100)
  const zoomLevel = Math.max(0, ZOOM_STEPS.findIndex(step => step >= timelineZoom - 0.0001))
  // Music lane: one mark under every clip that has music, in the clip's
  // colour, so it is clear which clip each track belongs to.
  const musicMarks = clips.flatMap(clip => {
    const music = effectiveMusic(projectMusic, clip.music)
    if (!music) return []
    return clipSegments(clip).map((segment, index) => ({
      key: `${clip.id}-${index}`, clip, start: segment.start, end: segment.end, first: index === 0,
      own: clip.music !== undefined, name: musicTrackName(music.track),
    }))
  })
  const hint = hasSource ? 'Drag edges to trim · I / O mark in and out · Space plays · Ctrl K for every action' : 'Open a video to start'
  const canOpenPanels = hasSource && !loading
  const pickedCount = [...momentPicks].filter(key => !clips.some(clip => momentKey(clip) === key)).length

  const reorderClip = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length || busy) return
    recordEdit()
    setClips(items => {
      const next = items.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }
  const dragFrom = useRef<number | null>(null)
  const previewClip = (clip: Clip) => {
    selectClip(clip)
    requestAnimationFrame(() => togglePlay())
  }
  const exportOnly = (clip: Clip) => {
    setExportChecked(new Set([clip.id]))
    setPanel(null)
    setExportOpen(true)
  }
  const duplicateClip = (clip: Clip) => {
    if (busy || clips.length >= MAX_CLIPS) return
    recordEdit()
    const copy = { ...clip, id: nextId.current++, title: clip.title ? `${clip.title.slice(0, 73)} (copy)` : undefined }
    setClips(items => items.flatMap(item => item.id === clip.id ? [item, copy] : [item]))
    setClipActions(null)
    selectClip(copy)
  }
  const removeClip = (clip: Clip) => {
    if (captionJob.current?.keys.has(`clip-${clip.id}`)) return
    recordEdit()
    setClipActions(null)
    setClips(items => items.filter(item => item.id !== clip.id))
    if (selectedId === clip.id) setSelectedId(null)
  }
  const addCaptionsFor = (id: number) => {
    const clip = clips.find(item => item.id === id)
    if (!clip) return
    setExportOpen(false)
    captionClip(clip)
  }

  // Clip rows are memoized so a trim drag, a caption keystroke or a wheel pan no
  // longer re-renders every row. They get one never-changing actions object
  // whose methods forward to the handlers of the latest render.
  const rowHandlers: ClipRowActions = {
    select: (clip, clicks) => {
      if (clicks === 1) renameClick.current = clip.id
      selectClip(clip)
    },
    doubleClick: (clip, locked) => {
      if (locked || renameClick.current !== clip.id) return
      renameClick.current = null
      setRenaming(clip.id)
    },
    startRename: id => { renameClick.current = null; setRenaming(id) },
    cancelRename: () => setRenaming(null),
    rename: renameClip,
    reorder: reorderClip,
    dragStart: index => { dragFrom.current = index },
    isDragging: () => dragFrom.current !== null,
    drop: index => {
      if (dragFrom.current !== null && index >= 0) reorderClip(dragFrom.current, index)
      dragFrom.current = null
    },
    dragEnd: () => { dragFrom.current = null },
    toggleMenu: id => setClipActions(current => current === id ? null : id),
    closeMenu: closeClipActions,
    preview: previewClip,
    retitle: clip => void titleClip(clip),
    captions: captionClip,
    update: updateClip,
    duplicate: duplicateClip,
    exportOnly,
    remove: removeClip,
  }
  const rowHandlersRef = useRef(rowHandlers)
  rowHandlersRef.current = rowHandlers
  const rowActions = useMemo<ClipRowActions>(() => {
    const latest = () => rowHandlersRef.current
    return {
      select: (clip, clicks) => latest().select(clip, clicks),
      doubleClick: (clip, locked) => latest().doubleClick(clip, locked),
      startRename: id => latest().startRename(id),
      cancelRename: () => latest().cancelRename(),
      rename: (id, title) => latest().rename(id, title),
      reorder: (from, to) => latest().reorder(from, to),
      dragStart: index => latest().dragStart(index),
      isDragging: () => latest().isDragging(),
      drop: index => latest().drop(index),
      dragEnd: () => latest().dragEnd(),
      toggleMenu: id => latest().toggleMenu(id),
      closeMenu: () => latest().closeMenu(),
      preview: clip => latest().preview(clip),
      retitle: clip => latest().retitle(clip),
      captions: clip => latest().captions(clip),
      update: clip => latest().update(clip),
      duplicate: clip => latest().duplicate(clip),
      exportOnly: clip => latest().exportOnly(clip),
      remove: clip => latest().remove(clip),
    }
  }, [])

  const clipMenuItems = (clip: Clip): MenuItem[] => {
    const locked = clipLocked(clip.id)
    return [
      { label: 'Play this clip', icon: <Play size={14} />, run: () => previewClip(clip) },
      { label: 'Rename', icon: <Pencil size={14} />, shortcut: 'F2', disabled: locked, run: () => { selectClip(clip); setRenaming(clip.id) } },
      { label: clip.title ? 'Retitle with AI' : 'Title with AI', icon: <Sparkles size={14} />, disabled: locked, run: () => void titleClip(clip) },
      { label: clipsNeedingCaptions([clip]).length ? 'Generate captions' : 'Edit captions', icon: <Subtitles size={14} />, disabled: locked, run: () => captionClip(clip) },
      { label: 'Music for this clip', icon: <Music2 size={14} />, disabled: locked, run: () => { selectClip(clip); togglePanel('music') } },
      'separator',
      { label: 'Update from timeline range', icon: <Check size={14} />, disabled: locked || busy || !validRange(range, duration), run: () => updateClip(clip) },
      { label: 'Duplicate', icon: <Copy size={14} />, disabled: busy || clips.length >= MAX_CLIPS, run: () => duplicateClip(clip) },
      { label: 'Export only this clip', icon: <ArrowDownToLine size={14} />, disabled: busy, run: () => exportOnly(clip) },
      'separator',
      { label: 'Remove clip', icon: <Trash2 size={14} />, danger: true, disabled: locked || Boolean(captionJob.current?.keys.has(`clip-${clip.id}`)), run: () => removeClip(clip) },
    ]
  }

  // Right-click shows actions for whatever is under the pointer. Text fields
  // keep the system menu so copy and paste still work there.
  const openContextMenu = (event: ReactMouseEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    const at = { x: event.clientX, y: event.clientY }
    const clipElement = target.closest<HTMLElement>('[data-clip-id]')
    const clip = clipElement ? clips.find(item => item.id === Number(clipElement.dataset.clipId)) : undefined
    if (clip) {
      setContextMenu({ ...at, title: clipName(clip), items: clipMenuItems(clip) })
      return
    }
    const lane = target.closest<HTMLElement>('.track, .ruler, .sound-lane, .words-lane, .music-lane')
    if (lane && hasSource) {
      const bounds = (timelineBody.current ?? lane).getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)))
      const time = Math.max(0, Math.min(duration, visibleTime.start + fraction * visibleTime.span))
      const under = lane.classList.contains('track')
        ? clips.find(item => clipSegments(item).some(segment => time >= segment.start && time <= segment.end))
        : undefined
      if (under) {
        setContextMenu({ ...at, title: clipName(under), items: [
          { label: 'Move playhead here', icon: <Play size={14} />, run: () => seek(time) }, 'separator', ...clipMenuItems(under),
        ] })
        return
      }
      setContextMenu({ ...at, title: `Timeline · ${stamp(time)}`, items: [
        { label: 'Move playhead here', icon: <Play size={14} />, run: () => seek(time) },
        { label: 'Set In here', icon: <ChevronRight size={14} />, disabled: trimDisabled, run: () => { editBoundary('start', time) } },
        { label: 'Set Out here', icon: <ChevronLeft size={14} />, disabled: trimDisabled, run: () => { editBoundary('end', time) } },
        'separator',
        { label: 'Add clip from In–Out', icon: <Plus size={14} />, shortcut: 'Enter', disabled: trimDisabled || !canSaveRange || editingCaptionJob, run: addClip },
        { label: 'Split at playhead', icon: <Split size={14} />, disabled: trimDisabled || !canSaveRange || editingCaptionJob, run: splitAtPlayhead },
        { label: 'Delete In–Out range', icon: <ScissorsLineDashed size={14} />, danger: true, disabled: !canTrim, run: trimSection },
        'separator',
        { label: 'Zoom in', icon: <ZoomIn size={14} />, shortcut: 'Ctrl +', disabled: timelineZoom === MAX_TIMELINE_ZOOM, run: () => zoomTimelineTo(timelineZoom * 2) },
        { label: 'Zoom out', icon: <ZoomOut size={14} />, shortcut: 'Ctrl -', disabled: timelineZoom === 1, run: () => zoomTimelineTo(timelineZoom / 2) },
        { label: 'Fit whole video', icon: <Film size={14} />, shortcut: 'Ctrl 0', disabled: timelineZoom === 1, run: () => zoomTimelineTo(1) },
      ] })
      return
    }
    if (target.closest('.stage') && hasSource) {
      setContextMenu({ ...at, title: 'Preview', items: [
        { label: playerPlaying ? 'Pause' : 'Play', icon: playerPlaying ? <Pause size={14} /> : <Play size={14} />, shortcut: 'Space', run: togglePlay },
        { label: 'Add clip from In–Out', icon: <Plus size={14} />, shortcut: 'Enter', disabled: trimDisabled || !canSaveRange || editingCaptionJob, run: addClip },
        'separator',
        { label: 'Center picture', icon: <Move size={14} />, disabled: !canPosition, run: () => setFramePosition(CENTER) },
        { label: 'Frame settings', icon: <Crop size={14} />, run: () => togglePanel('frame') },
        { label: 'Captions', icon: <Subtitles size={14} />, run: () => togglePanel('captions') },
        'separator',
        { label: 'Export…', icon: <ArrowDownToLine size={14} />, disabled: !hasSource || loading, run: openExport },
      ] })
      return
    }
    setContextMenu({ ...at, items: [
      { label: 'Open video…', icon: <FolderOpen size={14} />, shortcut: 'Ctrl O', disabled: busy || loading, run: () => void chooseVideo() },
      { label: 'Find clips with AI…', icon: <Sparkles size={14} />, shortcut: '/', disabled: !hasSource, run: () => { setMomentsOpen(true); askInput.current?.focus() } },
      { label: 'All actions…', icon: <Search size={14} />, shortcut: 'Ctrl K', run: () => setPaletteOpen(true) },
      'separator',
      { label: 'Export…', icon: <ArrowDownToLine size={14} />, disabled: !hasSource || loading, run: openExport },
      { label: 'Settings', icon: <SettingsIcon size={14} />, run: () => setSettingsOpen(true) },
    ] })
  }

  const RAIL: { id: Exclude<Panel, null>; label: string; icon: ReactNode; badge?: number; busy?: boolean }[] = [
    { id: 'captions', label: 'Captions', icon: <Subtitles size={19} />, busy: captionsRunning },
    { id: 'text', label: 'Text', icon: <Type size={19} /> },
    { id: 'music', label: 'Music', icon: <Music2 size={19} /> },
    { id: 'bookends', label: 'Intro/Outro', icon: <Clapperboard size={19} /> },
    { id: 'frame', label: 'Frame', icon: <Crop size={19} /> },
  ]

  const noVideo = !hasSource || loading
  const commands: PaletteCommand[] = [
    { id: 'open', group: 'Video', label: 'Open video…', icon: <FolderOpen size={16} />, shortcut: 'Ctrl O', keywords: 'import file', run: () => void chooseVideo() },
    { id: 'play', group: 'Video', label: playerPlaying ? 'Pause' : 'Play', icon: <Play size={16} />, shortcut: 'Space', disabled: noVideo, run: togglePlay },
    { id: 'mute', group: 'Video', label: muted ? 'Unmute preview' : 'Mute preview', icon: <Volume2 size={16} />, disabled: noVideo, run: () => setMuted(value => !value) },
    { id: 'find', group: 'Find', label: 'Find clips with AI…', icon: <Sparkles size={16} />, shortcut: '/', keywords: 'smart split moments search', disabled: noVideo, run: () => { setMomentsOpen(true); askInput.current?.focus() } },
    { id: 'clear-find', group: 'Find', label: 'Clear clip suggestions', icon: <Trash2 size={16} />, disabled: !moments.length || momentRunning, run: clearMoments },
    { id: 'listen', group: 'Find', label: 'Show what is said on the timeline', icon: <AudioLines size={16} />, keywords: 'transcript words listen', disabled: noVideo || listening !== null, run: () => void listenToVideo() },
    { id: 'add', group: 'Edit', label: selectedLocked ? 'New clip' : 'Add current range as clip', icon: <Plus size={16} />, shortcut: 'Enter', disabled: trimDisabled || !canSaveRange, run: addClip },
    { id: 'mark-in', group: 'Edit', label: 'Mark In at playhead', icon: <ChevronLeft size={16} />, shortcut: 'I', disabled: trimDisabled, run: () => editBoundary('start', activeTime()) },
    { id: 'mark-out', group: 'Edit', label: 'Mark Out at playhead', icon: <ChevronRight size={16} />, shortcut: 'O', disabled: trimDisabled, run: () => editBoundary('end', activeTime()) },
    { id: 'reset-range', group: 'Edit', label: 'Reset trim range', icon: <RotateCcw size={16} />, disabled: trimDisabled, run: resetRange },
    { id: 'split-playhead', group: 'Edit', label: 'Split range at playhead', icon: <Split size={16} />, disabled: trimDisabled || !canSaveRange, run: splitAtPlayhead },
    ...[15, 30, 60, 120, 300].map(seconds => ({ id: `split-${seconds}`, group: 'Edit', label: `Split range every ${seconds < 60 ? `${seconds} seconds` : `${seconds / 60} min`}`,
      icon: <Split size={16} />, keywords: splitMode === 'add' ? 'split and add clips' : 'mark sections', disabled: trimDisabled || !canSaveRange, run: () => splitParts(splitRange(range, seconds)) })),
    { id: 'split-mode', group: 'Edit', label: splitMode === 'mark' ? 'Splits add clips instead of marking' : 'Splits only mark sections', icon: <Split size={16} />, run: () => setSplitMode(mode => mode === 'mark' ? 'add' : 'mark') },
    { id: 'delete-range', group: 'Edit', label: 'Delete range from the video (ripple)', icon: <ScissorsLineDashed size={16} />, keywords: 'trim remove cut', disabled: !canTrim, run: trimSection },
    { id: 'undo', group: 'Edit', label: 'Undo', icon: <Undo2 size={16} />, shortcut: 'Ctrl Z', disabled: !canUndo, run: undoEdit },
    { id: 'redo', group: 'Edit', label: 'Redo', icon: <Redo2 size={16} />, shortcut: 'Ctrl Shift Z', disabled: !canRedo, run: redoEdit },
    { id: 'zoom-in', group: 'Timeline', label: 'Zoom in', icon: <ZoomIn size={16} />, shortcut: 'Ctrl +', disabled: noVideo, run: () => zoomTimelineTo(timelineZoom * 2) },
    { id: 'zoom-out', group: 'Timeline', label: 'Zoom out', icon: <ZoomOut size={16} />, shortcut: 'Ctrl -', disabled: noVideo, run: () => zoomTimelineTo(timelineZoom / 2) },
    { id: 'zoom-fit', group: 'Timeline', label: 'Fit entire timeline', icon: <Minus size={16} />, shortcut: 'Ctrl 0', disabled: noVideo, run: () => zoomTimelineTo(1) },
    ...(sections.length ? [
      { id: 'next-section', group: 'Timeline', label: 'Review next marked section', icon: <ChevronRight size={16} />, run: () => reviewSection(sections, reviewIndex === null ? 0 : Math.min(sections.length - 1, reviewIndex + 1)) },
      { id: 'clear-sections', group: 'Timeline', label: 'Clear section marks', icon: <X size={16} />, run: () => { setSections([]); setReviewIndex(null) } },
    ] : []),
    { id: 'auto-title', group: 'Clips', label: autoTitles ? 'Turn off automatic clip titles' : 'Name new clips automatically with AI', icon: <Sparkles size={16} />, keywords: 'auto title', disabled: busy, run: () => void toggleAutoTitles() },
    ...(selectedClip ? [
      { id: 'retitle', group: 'Clips', label: selectedClip.title ? 'Retitle selected clip with AI' : 'Title selected clip with AI', icon: <Sparkles size={16} />, disabled: busy || captionsRunning || Boolean(titleProgress), run: () => void titleClip(selectedClip) },
      { id: 'rename', group: 'Clips', label: 'Rename selected clip', icon: <Pencil size={16} />, shortcut: 'F2', disabled: selectedLocked, run: () => setRenaming(selectedClip.id) },
      { id: 'duplicate', group: 'Clips', label: 'Duplicate selected clip', icon: <Copy size={16} />, disabled: busy, run: () => duplicateClip(selectedClip) },
      { id: 'update-range', group: 'Clips', label: 'Update selected clip from trim range', icon: <Check size={16} />, disabled: busy || !canSaveRange, run: () => updateClip(selectedClip) },
      { id: 'remove', group: 'Clips', label: 'Remove selected clip', icon: <Trash2 size={16} />, disabled: selectedLocked, run: () => removeClip(selectedClip) },
    ] : []),
    { id: 'captions', group: 'Captions', label: 'Captions — generate, edit, style', icon: <Subtitles size={16} />, disabled: !canOpenPanels, run: () => togglePanel('captions') },
    { id: 'caption-all', group: 'Captions', label: 'Caption all clips', icon: <Subtitles size={16} />, disabled: busy || captionsRunning || Boolean(titleProgress) || !clipsNeedingCaptions(clips).length, run: captionStack },
    { id: 'caption-style-all', group: 'Captions', label: 'Apply caption style to all clips', icon: <Copy size={16} />, disabled: !captionStyle || busy || captionsRunning, run: () => { if (captionStyle) applyCaptionStyle(captionStyle) } },
    { id: 'caption-auto', group: 'Captions', label: preferences.autoCaption ? 'Stop captioning new clips automatically' : 'Caption new clips automatically', icon: <Subtitles size={16} />, run: toggleAutoCaptionPreference },
    { id: 'text', group: 'Add', label: 'Text on picture', icon: <Type size={16} />, disabled: !canOpenPanels || busy, run: () => togglePanel('text') },
    { id: 'add-text', group: 'Add', label: 'Add a text block', icon: <Plus size={16} />, disabled: !canOpenPanels || busy, run: () => { setPanel('text'); addText() } },
    { id: 'music', group: 'Add', label: 'Background music', icon: <Music2 size={16} />, disabled: !canOpenPanels, run: () => togglePanel('music') },
    { id: 'bookends', group: 'Add', label: 'Intro / outro', icon: <Clapperboard size={16} />, disabled: !canOpenPanels || busy, run: () => togglePanel('bookends') },
    { id: 'frame', group: 'Output', label: 'Frame — fill, fit and position', icon: <Crop size={16} />, disabled: !canOpenPanels, run: () => togglePanel('frame') },
    { id: 'format', group: 'Output', label: format === 'portrait' ? 'Switch to Landscape 16:9' : 'Switch to Vertical 9:16', icon: format === 'portrait' ? <Monitor size={16} /> : <Smartphone size={16} />, disabled: selectedLocked, run: () => setFormat(format === 'portrait' ? 'landscape' : 'portrait') },
    { id: 'framing', group: 'Output', label: framing === 'fill' ? 'Fit the whole picture' : 'Fill the frame', icon: <Crop size={16} />, disabled: selectedLocked, run: () => setFraming(framing === 'fill' ? 'fit' : 'fill') },
    { id: 'center', group: 'Output', label: 'Center picture in frame', icon: <Move size={16} />, disabled: !canPosition, run: () => setFramePosition(CENTER) },
    { id: 'export', group: 'Output', label: 'Export clips…', icon: <ArrowDownToLine size={16} />, shortcut: 'Ctrl E', disabled: noVideo, run: openExport },
    { id: 'export-selected', group: 'Output', label: 'Export only the selected clip', icon: <ArrowDownToLine size={16} />, disabled: noVideo || !selectedClip || busy, run: () => { if (selectedClip) exportOnly(selectedClip) } },
    { id: 'cancel-export', group: 'Output', label: 'Cancel export', icon: <X size={16} />, disabled: !busy || cancelingExport, run: cancelExport },
    { id: 'export-folder', group: 'Output', label: 'Open export folder', icon: <FolderOpen size={16} />, disabled: !summary?.saved, run: () => void invoke('open_export_folder').catch(error => setNotice(message(error))) },
    { id: 'choose-folder', group: 'Output', label: 'Change export folder…', icon: <FolderOpen size={16} />, run: () => void chooseExportFolder() },
    { id: 'settings', group: 'App', label: 'Settings', icon: <SettingsIcon size={16} />, keywords: 'preferences models updates', run: () => setSettingsOpen(true) },
    { id: 'shortcuts', group: 'App', label: 'Keyboard shortcuts', icon: <Keyboard size={16} />, run: () => setShortcuts(true) },
    { id: 'updates', group: 'App', label: 'Check for updates', icon: <RotateCcw size={16} />, run: () => void updates.checkForUpdates(true) },
  ]

  return (
    <div className="app" onContextMenu={openContextMenu}>
      <header className="topbar">
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><Scissors size={17} /></span></div>
        <div className="project" data-tauri-drag-region>
          <strong title={source?.name}>{source ? baseName : 'MiniVidCut'}</strong>
          {source && <small>{stamp(duration)} · {clips.length} {clips.length === 1 ? 'clip' : 'clips'}</small>}
        </div>
        <button className="icon-button" title="Open video (Ctrl O)" aria-label="Open video" disabled={busy || loading} onClick={() => void chooseVideo()}><FolderOpen size={16} /></button>
        <div className="titlebar-space" data-tauri-drag-region />
        <button type="button" className="ask" onClick={() => setPaletteOpen(true)} aria-haspopup="dialog" title="Search every action (Ctrl K)">
          <Search size={16} aria-hidden="true" />
          <span>Search actions, tools and settings…</span>
          <kbd aria-hidden="true">Ctrl K</kbd>
        </button>
        <div className="titlebar-space" data-tauri-drag-region />
        <div className="top-actions">
          <UpdateIndicator update={updates} />
          <button className="icon-button pill-icon settings-trigger" aria-label="Settings" title="Settings"
            aria-pressed={settingsOpen} onClick={() => { setMomentsOpen(false); setSettingsOpen(open => !open) }}><SettingsIcon size={16} /></button>
          <button type="button" className="button primary export-trigger" aria-haspopup="dialog"
            disabled={!hasSource || loading || (!clips.length && sections.length > 0 && !hasKeptEdit)} onClick={openExport}>
            {busy ? <span className="export-ring" role="progressbar" aria-label="Export progress" aria-valuenow={summary?.percent ?? 0}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${summary?.percent ?? 0} 100`} /></svg>
            </span> : <ArrowDownToLine size={15} />}
            {busy ? `Exporting ${summary?.percent ?? 0}%` : `Export${clips.length ? ` ${clips.length}` : ''}`}
          </button>
        </div>
        {isTauri() && <div className="window-controls" role="group" aria-label="Window controls">
          <button aria-label="Minimize" title="Minimize" onClick={() => runWindowAction('minimize')}><Minus size={15} /></button>
          <button aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => runWindowAction('toggleMaximize')}>
            {maximized ? <Copy size={13} /> : <Square size={12} />}
          </button>
          <button className="window-close" aria-label="Close" title="Close" onClick={() => runWindowAction('close')}><X size={16} /></button>
        </div>}
      </header>


      <UpdatePrompt update={updates} />
      <Settings open={settingsOpen} onClose={() => { setSettingsOpen(false); setSettingsSection(undefined) }} section={settingsSection} update={updates}
        preferences={preferences} onPreferences={setPreferences} projectName={source ? baseName : ''} projectMeta={source ? `${stamp(duration)} · ${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}` : ''}
        autoTitles={autoTitles} onToggleAutoTitles={() => void toggleAutoTitles()}
        exportFolder={exportFolder} onChooseExportFolder={() => void chooseExportFolder()} onClearExportFolder={clearExportFolder}
        onModelsChanged={(removed) => {
          if (removed) {
            localStorage.removeItem(TITLE_DOWNLOAD_KEY)
            localStorage.removeItem(AUTO_TITLES_KEY)
            setAutoTitles(false)
          }
          void refreshCaptionModel().catch(() => {})
        }} />
      <main hidden={settingsOpen} className={`workspace${timelineZoom > 1 ? ' timeline-zoomed' : ''}${sections.length ? ' reviewing' : ''}${hasSource ? ' docked' : ''}${momentsOpen && hasSource ? ' finding' : ''}`}>
        <nav className="rail" aria-label="Tools">
          {RAIL.map(item => <button key={item.id} id={`rail-${item.id}`} className="rail-button" aria-pressed={panel === item.id}
            aria-controls={`${item.id}-panel`} disabled={!canOpenPanels || ((item.id === 'text' || item.id === 'bookends') && busy)}
            onClick={() => togglePanel(item.id)}>
            {item.busy ? <LoaderCircle size={19} className="spin" /> : item.icon}
            <span>{item.label}</span>
            {item.badge !== undefined && <em className="rail-badge">{item.badge}</em>}
          </button>)}
          <button id="rail-smart-split" className="rail-button" aria-pressed={momentsOpen} aria-controls="find-panel" aria-expanded={momentsOpen}
            disabled={!hasSource || loading} title="Smart split: find clips with AI or split by time (/)"
            onClick={() => setMomentsOpen(open => !open)}>
            {momentRunning ? <LoaderCircle size={19} className="spin" /> : <Sparkles size={19} />}
            <span>Smart split</span>
          </button>
        </nav>

        {momentsOpen && hasSource && <section className="find-panel" id="find-panel" aria-label="Find clips" onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (presetMenu) { setPresetMenu(false); return }
          setMomentsOpen(false)
          askInput.current?.blur()
        }}>
          <div className="seg wide find-tabs" role="tablist" aria-label="Smart split mode">
            <button type="button" role="tab" aria-selected={findTab === 'find'} aria-pressed={findTab === 'find'} onClick={() => setFindTab('find')}><Sparkles size={13} /> Find clips</button>
            <button type="button" role="tab" aria-selected={findTab === 'time'} aria-pressed={findTab === 'time'} onClick={() => setFindTab('time')}><Split size={13} /> Split by time</button>
          </div>
          {findTab === 'find' && <>
            <div className="find-ask-wrap">
              <form className="find-ask" role="search" onSubmit={event => {
                event.preventDefault()
                const text = askInput.current?.value.trim() ?? ''
                if (text.startsWith('/')) {
                  if (presetMatches[0]) choosePreset(presetMatches[0])
                  return
                }
                setPresetMenu(false)
                requestSearch(text || DEFAULT_MOMENT_QUERY)
              }}>
                <button type="button" className="find-menu-button" aria-label="Quick searches" aria-haspopup="menu" aria-expanded={presetMenu}
                  title="Quick searches (or type / in the box)" onClick={() => { setPresetFilter(''); setPresetMenu(open => !open) }}>
                  {momentRunning ? <LoaderCircle size={15} className="spin" aria-label="Finding clips" /> : <Sparkles size={15} />}
                </button>
                <input ref={askInput} name="prompt" maxLength={240} disabled={!hasSource || loading} aria-label="Describe the clips to find"
                  autoComplete="off" defaultValue={momentQuery} placeholder="Describe the clips, or type / for ideas"
                  onChange={event => {
                    const text = event.target.value
                    if (text.startsWith('/')) { setPresetMenu(true); setPresetFilter(text.slice(1).trim().toLowerCase()) }
                    else setPresetFilter('')
                  }} />
              </form>
              {presetMenu && <div className="find-menu" role="menu" aria-label="Quick searches">
                {presetMatches.length ? presetMatches.map(preset => <button key={preset.id} type="button" role="menuitem" disabled={momentRunning || loading}
                  title={preset.request} onClick={() => choosePreset(preset)}>
                  {PRESET_ICONS[preset.id]}<span>{preset.label}</span>
                </button>) : <p className="find-menu-empty">No quick search matches. Press Enter to search for “{presetFilter}” instead.</p>}
              </div>}
            </div>
            {preferences.aiProvider !== 'local' && <p className="find-agent"><Sparkles size={12} aria-hidden="true" /> Picked by {agentMeta(preferences.aiProvider).name}
              <button type="button" className="link-button" onClick={openAiSettings}>Change</button></p>}
            {agentIssue && !momentRunning && <div className="agent-fix">
              <AgentSetup only={agentIssue} preferences={preferences} onPreferences={setPreferences}
                onDone={() => { setAgentIssue(null); setMomentStatus('Signed in. Run your search again.') }} />
            </div>}
            <div className="find-options">
              <div className="find-row">
                <span>Length</span>
                <div className="seg" role="group" aria-label="Maximum clip length">
                  {[15, 30, 60].map(seconds => <button key={seconds} type="button" aria-pressed={momentLength === seconds} onClick={() => setMomentLength(seconds)}>{seconds}s</button>)}
                  <label className="seg-custom"><input type="number" min={1} max={120} aria-label="Custom maximum seconds" value={momentLength}
                    onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setMomentLength(Math.max(1, Math.min(120, Math.round(value)))) }} />s</label>
                </div>
              </div>
              <div className="find-row">
                <span>Count</span>
                <div className="seg" role="group" aria-label="Number of suggestions">
                  {[3, 5, 10].map(count => <button key={count} type="button" aria-pressed={momentCount === count} onClick={() => setMomentCount(count)}>{count}</button>)}
                  <label className="seg-custom"><input type="number" min={1} max={MAX_CLIPS} aria-label="Custom number of suggestions" value={momentCount}
                    onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setMomentCount(Math.max(1, Math.min(MAX_CLIPS, Math.round(value)))) }} /></label>
                </div>
                <button className="button primary small" disabled={momentRunning || loading}
                  onClick={() => requestSearch(askInput.current?.value.trim().replace(/^\/.*$/, '') || DEFAULT_MOMENT_QUERY)}><Sparkles size={14} /> Find</button>
              </div>
            </div>
            {momentRunning ? <div className="find-progress">
              <p role="status">{momentStatus}</p>
              <button className="button outline small" onClick={stopMomentSearch} disabled={momentStopping}>{momentStopping ? 'Stopping…' : 'Stop'}</button>
              <div className="thin-bar"><i style={{ width: `${Math.round((momentProgress ?? 0) * 100)}%` }} /></div>
            </div> : momentStatus ? <p className="find-status" role="status">{momentStatus}</p>
              : !moments.length && <p className="find-status">Describe what you want in plain words, like “the funniest moments”, or type / for ideas. {preferences.aiProvider === 'local'
                ? <>The transcript is searched on this device. <button type="button" className="link-button" onClick={openAiSettings}>Use Claude Code, Codex or OpenCode instead</button></>
                : `The transcript text is sent to ${agentMeta(preferences.aiProvider).name} to pick the clips.`}</p>}
            {moments.length > 0 && <ol className="find-results">{moments.map((moment, index) => {
              const key = momentKey(moment)
              const added = clips.some(clip => clip.start === moment.start && clip.end === moment.end)
              return <li key={key} className={momentPicks.has(key) && !added ? 'picked' : ''}>
                <input type="checkbox" className="check" checked={added || momentPicks.has(key)} disabled={added}
                  aria-label={`Select suggestion ${index + 1}`} onChange={() => setMomentPicks(current => {
                    const next = new Set(current)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })} />
                <span className="find-thumb" style={{ aspectRatio: activeFormat.aspect }}>{clipFrames[moment.start] && <img alt="" src={clipFrames[moment.start]} />}</span>
                <span className="find-text"><q title={moment.text}>{moment.text}</q>
                  <small><span className="duration-chip">{clipDuration(moment.end - moment.start)}</span> {stamp(moment.start)} · <button className="link-button" disabled={preview !== 'direct' && preview !== 'proxy'}
                    onClick={() => previewMoment(moment)}><Play size={11} /> preview</button></small>
                  {moment.reason && <small className="find-reason">{moment.reason}</small>}</span>
                <span className="find-rank" title="Order the AI ranked this suggestion">{added ? <><Check size={13} /> Added</> : `#${index + 1}`}</span>
              </li>
            })}</ol>}
            {moments.length > 0 && <div className="find-footer">
              <span>{pickedCount} selected</span>
              <button className="button outline small" disabled={momentRunning} onClick={clearMoments}>Clear</button>
              <button className="button primary small" disabled={busy || !pickedCount}
                onClick={addPickedMoments}>{pickedCount ? `Add ${pickedCount} ${pickedCount === 1 ? 'clip' : 'clips'}` : 'Add clips'}</button>
            </div>}
          </>}
          {findTab === 'time' && <div className="find-time">
            <div className="find-time-head">
              <span>Split the range into equal parts</span>
              <div className="seg split-mode" role="group" aria-label="Split behavior">
                <button type="button" aria-pressed={splitMode === 'mark'} onClick={() => setSplitMode('mark')}>Mark only</button>
                <button type="button" aria-pressed={splitMode === 'add'} onClick={() => setSplitMode('add')}>Split &amp; add</button>
              </div>
            </div>
            <div className="find-presets" role="group" aria-label="Split the trim range">
              <button type="button" className="find-preset" disabled={trimDisabled || !canSaveRange || editingCaptionJob} onClick={splitAtPlayhead}><Split size={13} /> At playhead</button>
              {[15, 30, 60, 120, 300].map(seconds => <button key={seconds} type="button" className="find-preset" disabled={trimDisabled || !canSaveRange || editingCaptionJob}
                onClick={() => splitParts(splitRange(range, seconds))}><Split size={13} /> {seconds < 60 ? `Every ${seconds}s` : `Every ${seconds / 60} min`}</button>)}
            </div>
          </div>}
        </section>}

        <section className="viewer" aria-label="Video preview">
          <div className={`stage ${format} ${dragging ? 'dragging' : ''}`}>
            {hasSource ? (
              <>
                {[previousClip, nextClip].map((clip, side) => clip && <button key={side ? 'next' : 'previous'} className={`neighbor ${side ? 'next' : 'previous'}`}
                  title={`${side ? 'Next' : 'Previous'} clip · ${clipName(clip)}`} disabled={disabled}
                  onClick={() => selectClip(clip)}>
                  <span className="neighbor-frame">{clipFrames[clip.start] && <img alt="" src={clipFrames[clip.start]}
                    style={{ objectFit: framing === 'fill' ? 'cover' : 'contain', objectPosition }} />}</span>
                  <span className="neighbor-title">{clipName(clip)}</span>
                </button>)}
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
                  {activeTexts.length > 0 && <TextOverlayPreview overlays={activeTexts} format={format}
                    selectedId={selectedText?.id ?? null} draggable={panel === 'text' && !disabled}
                    onPosition={(id, x, y) => {
                      const layer = activeTexts.find(text => text.id === id)
                      if (layer) saveText(moveText(layer, x, y))
                    }} />}
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
                <h1>Drop a long video here</h1>
                <p>Then describe the clips you want, or mark them by hand.</p>
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
            {dragging && <div className="drop-overlay"><FolderOpen size={28} /> {panel === 'music' ? 'Drop to import music' : 'Drop to open video'}</div>}
          </div>
          <div className="transport">
            <div className="seg format-options" role="group" aria-label="Output format">
              {(Object.keys(FORMATS) as Format[]).map(option => <button key={option} title={`${FORMATS[option].label} ${FORMATS[option].ratio}`}
                aria-pressed={option === format} disabled={selectedLocked} onClick={() => setFormat(option)}>{FORMATS[option].ratio}</button>).reverse()}
            </div>
            <button className="icon-button compact" aria-label="Seek back 5 seconds" title="Back 5 seconds (Shift ←)" disabled={disabled} onClick={() => seekPlayback(-5)}><Rewind size={15} /></button>
            <button className="icon-button compact" aria-label="Seek back 1 second" title="Back 1 second (←)" disabled={disabled} onClick={() => seekPlayback(-1)}><ChevronLeft size={16} /></button>
            <button className="icon-button play" aria-label={sequence.preparing ? 'Cancel clip preview' : playerPlaying ? 'Pause' : 'Play'} title="Play / pause (Space)"
              onClick={togglePlay} disabled={!source || (!sequenceKey && !canMixPreview)}>
              {sequence.preparing ? <Square size={14} /> : playerPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            </button>
            <button className="icon-button compact" aria-label="Seek forward 1 second" title="Forward 1 second (→)" disabled={disabled} onClick={() => seekPlayback(1)}><ChevronRight size={16} /></button>
            <button className="icon-button compact" aria-label="Seek forward 5 seconds" title="Forward 5 seconds (Shift →)" disabled={disabled} onClick={() => seekPlayback(5)}><FastForward size={15} /></button>
            <ClockDisplay duration={duration} />
            {sequence.path && <button className="icon-button compact" title="Return to source preview" aria-label="Return to source preview" onClick={stopSequence}><X size={16} /></button>}
            <div className="transport-audio" role="group" aria-label="Preview audio">
              <button className="icon-button compact mute" aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} disabled={!source} onClick={() => {
                const next = !muted
                setMuted(next)
                if (sequence.player.current) sequence.player.current.setMuted(next)
              }}>
                {muted || !previewVolume ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <input aria-label="Preview volume" title="Preview volume" type="range" min={0} max={100}
                value={muted ? 0 : previewVolume} disabled={!source}
                onChange={event => {
                  setPreviewVolume(event.target.valueAsNumber)
                  setMuted(false)
                  if (sequence.player.current) sequence.player.current.setMuted(false)
                }} />
            </div>
          </div>
        </section>

        {hasSource && <section className="sheet left clips-sheet" id="clips-panel" aria-labelledby="clips-title">
          <header className="sheet-head">
            <div><h2 id="clips-title" className="display-title">Clips</h2>
              <p>{clips.length} {clips.length === 1 ? 'clip' : 'clips'} · {clipDuration(totalClipSeconds)} total</p></div>
            <button className="button outline small" disabled={disabled} onClick={() => { setMomentsOpen(true); askInput.current?.focus() }}><Sparkles size={14} /> Find more</button>
          </header>
          {clips.length > 0 && <div className="bulk-actions">
            <button className="button outline small" aria-pressed={autoTitles} disabled={disabled}
              title="Name every clip from what is said in it" onClick={() => void toggleAutoTitles()}><Sparkles size={14} /> Auto-title all</button>
            <button className="button outline small" disabled={disabled || captionsRunning || !clipsNeedingCaptions(clips).length}
              onClick={captionStack}><Subtitles size={14} /> Caption all{clipsNeedingCaptions(clips).length ? ` (${clipsNeedingCaptions(clips).length} missing)` : ''}</button>
            <button className="button outline small" disabled={!captionStyle || busy} title="Use the selected clip's caption look on every clip"
              onClick={() => { if (captionStyle) applyCaptionStyle(captionStyle) }}><Copy size={14} /> Apply look to all</button>
          </div>}
          {(titleProgress || titleError) && <div className="sheet-status" role="status">{titleProgress || titleError}
            {titleError && autoTitles && <button className="link-button" onClick={() => { titledClips.current.clear(); setTitleError('') }}>Retry</button>}
          </div>}
          {displayedClips.length === 0 ? <div className="empty-queue"><Scissors size={20} strokeWidth={1.5} /><span>No clips yet</span>
            <p>Find clips with AI, or mark In and Out on the timeline and press Add clip.</p></div> :
            <ol className="clip-list">{displayedClips.map((clip, index) => {
              const batchIndex = batchIndices.get(clip.id)
              const locked = clipLocked(clip.id)
              const clipOptions = locked ? exportBatch?.options : undefined
              const thumbPosition = clipOptions?.position ?? position
              const ends = effectiveBookends(projectBookends, clip.bookends)
              return <ClipRow key={clip.id} clip={clip} position={index} savedIndex={clips.indexOf(clip)}
                title={clip.title ?? `Clip ${String(index + 1).padStart(2, '0')}`}
                selected={clip.id === selectedId} locked={locked} editing={renaming === clip.id}
                disabled={disabled} busy={busy} reorderable={clips.length > 1}
                aspect={FORMATS[clipOptions?.format ?? format].aspect}
                fit={(clipOptions?.framing ?? framing) === 'fill' ? 'cover' : 'contain'}
                objectPosition={`${thumbPosition.x}% ${thumbPosition.y}%`}
                thumbnail={clipFrames[clip.start]}
                hasMusic={Boolean(effectiveMusic(projectMusic, clip.music))}
                hasText={normalizeTexts(clip.texts ?? clip.text).some(textActive)}
                hasBookends={Boolean(ends.intro || ends.outro)}
                needsCaptions={!clip.captions?.cues.some(cue => cue.text.trim())}
                state={batchIndex === undefined ? undefined : exportBatch?.states[batchIndex]}
                menuOpen={clipActions === clip.id}
                canUpdate={!busy && validRange(range, duration)}
                canDuplicate={!busy && clips.length < MAX_CLIPS}
                canRemove={!captionJob.current?.keys.has(`clip-${clip.id}`)}
                actions={rowActions} />
            })}</ol>}
          <footer className="sheet-foot">
            <span>Double-click a clip to rename</span>
            <button className="button outline small" disabled={!hasSource || loading} onClick={openExport}>Export all {clips.length || ''} <ChevronRight size={14} /></button>
          </footer>
        </section>}

        {panel === 'captions' && <section className="sheet right captions-sheet" id="captions-panel" aria-labelledby="captions-title" onKeyDown={event => {
          if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('input, select, textarea'))) { event.stopPropagation(); closeCaptions() }
        }}>
          <header className="sheet-head">
            <div><h2 id="captions-title" className="display-title">Captions</h2><p title={captionLabel}>For “{captionLabel}”</p></div>
            <button className="icon-button compact" aria-label="Close captions" onClick={closeCaptions}><X size={16} /></button>
          </header>
          {showCaptionEditor ? <>
            <div className="seg wide caption-tabs" role="tablist" aria-label="Captions view">
              <button type="button" role="tab" aria-selected={captionTab === 'captions'} aria-pressed={captionTab === 'captions'} onClick={() => setCaptionTab('captions')}><Subtitles size={13} /> Captions</button>
              <button type="button" role="tab" aria-selected={captionTab === 'style'} aria-pressed={captionTab === 'style'} onClick={() => setCaptionTab('style')}><SlidersHorizontal size={13} /> Style</button>
            </div>
            <div className="sheet-body">
              {captionTab === 'captions' && <CaptionEditor key={captionKey} label={captionLabel} range={range} track={activeCaptions}
                model={captionModel} progress={captionProgress} status={captionStatus?.key === captionKey || captionStatus?.key === 'batch' ? captionStatus.text : ''}
                editing={editingCaptionJob} canGenerate={!titleProgress}
                defaultStyle={sharedCaptionStyle.current ?? undefined}
                onChange={saveCaptions} onGenerate={generateCaptions} onCancel={cancelCaptions}
                onSeek={captionSeek} getTime={captionPlayhead} />}
              {captionTab === 'style' && (captionStyle && activeCaptions && activeCaptions.cues.length > 0 && !editingCaptionJob ? <>
                <div className="field-label">Look</div>
                <div className="looks" role="radiogroup" aria-label="Caption look">{CAPTION_LOOKS.map(look =>
                  <button key={look.id} role="radio" aria-checked={currentLook?.id === look.id} className={`look look-${look.id}`}
                    onClick={() => saveCaptionStyle(applyLook(captionStyle, look))}>{look.label}</button>)}</div>
                <div className="field-label">Placement</div>
                <div className="field-row"><span>Position</span>
                  <div className="seg" role="group" aria-label="Caption position">{(['top', 'middle', 'bottom'] as const).map(place =>
                    <button key={place} aria-pressed={!captionStyle.points?.[format] && captionStyle.position === place}
                      onClick={() => saveCaptionStyle({ ...captionStyle, position: place, points: { ...captionStyle.points, [format]: undefined } })}>{place[0].toUpperCase() + place.slice(1)}</button>)}</div></div>
                <label className="field-row"><span>Text size</span>
                  <PercentInput min={55} max={200} step={5} value={Math.round(captionScale)} label="Caption text size"
                    onCommit={value => saveCaptionStyle({ ...captionStyle, scale: value / 100 })} /></label>
                <div className="field-label">Text and outline</div>
                <CaptionStylePanel key={captionKey} embedded style={captionStyle}
                  format={format} editing={editingCaptionJob} canApplyStyle={!busy && !captionsRunning}
                  onStyle={saveCaptionStyle} onApplyStyle={applyCaptionStyle} onClose={() => setCaptionTab('captions')} />
                <div className="sheet-actions">
                  <button className="button primary" disabled={busy} onClick={() => applyCaptionStyle(captionStyle)}
                    title={`Give all ${clips.length > 1 ? `${clips.length} clips` : 'clips'} this look, position and size`}>
                    <Copy size={14} /> Apply to all clips</button>
                </div>
              </> : <p className="sheet-note">{editingCaptionJob ? 'Captions are being generated…' : <>Add captions to this clip first, then style them here. <button type="button" className="link-button" onClick={() => setCaptionTab('captions')}>Go to Captions</button></>}</p>)}
            </div>
          </> : <div className="empty-queue">
            <Subtitles size={21} />
            <p>{!hasSource ? 'Open a video to add captions.' : selectedLocked ? 'This clip is locked while it exports.' : 'Select a clip or mark a range to add captions.'}</p>
          </div>}
        </section>}

        {panel === 'frame' && <section className="sheet right frame-sheet" id="frame-panel" aria-labelledby="frame-title" onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); closePanel('frame') }
        }}>
          <header className="sheet-head">
            <div><h2 id="frame-title" className="display-title">Frame</h2><p>Shape and framing for every exported clip</p></div>
            <button className="icon-button compact" aria-label="Close frame" onClick={() => closePanel('frame')}><X size={16} /></button>
          </header>
          <div className="sheet-body">
            <div className="field-label">Format</div>
            <div className="seg wide" role="group" aria-label="Output format">
              <button aria-pressed={format === 'portrait'} disabled={selectedLocked} onClick={() => setFormat('portrait')}><Smartphone size={14} /> Vertical 9:16</button>
              <button aria-pressed={format === 'landscape'} disabled={selectedLocked} onClick={() => setFormat('landscape')}><Monitor size={14} /> Landscape 16:9</button>
            </div>
            <div className="field-label">Framing</div>
            <div className="choices">
              <button className="choice" role="radio" aria-checked={framing === 'fill'} disabled={selectedLocked} onClick={() => setFraming('fill')}>
                <b>Fill</b><small>Crop the picture to fill the whole frame</small></button>
              <button className="choice" role="radio" aria-checked={framing === 'fit'} disabled={selectedLocked} onClick={() => setFraming('fit')}>
                <b>Fit</b><small>Keep the whole picture, with bars around it</small></button>
            </div>
            <div className="field-label">Position</div>
            {canPosition && positionAxis ? <>
              <label className="field-row"><span>{positionAxis === 'x' ? 'Left ↔ right' : 'Top ↕ bottom'}</span>
                <PercentInput min={0} max={100} step={1} value={Math.round(position[positionAxis])}
                  label={positionAxis === 'x' ? 'Horizontal frame position' : 'Vertical frame position'}
                  onCommit={value => setFramePosition({ ...position, [positionAxis]: value })} /></label>
              <button className="button outline small" onClick={() => setFramePosition(CENTER)}><Move size={14} /> Center picture</button>
              <p className="sheet-note">You can also drag the picture in the preview.</p>
            </> : <p className="sheet-note">The whole picture already fits this frame, so there is nothing to move.</p>}
            <p className="sheet-note mono">{activeFormat.ratio} · {activeFormat.size}</p>
          </div>
        </section>}

        <MusicMenu key={`music-${musicSourceRevision}`} project={projectMusic}
          clip={selectedClip ? { music: selectedClip.music, title: selectedClip.title || 'Selected clip' } : null}
          open={panel === 'music'} onClose={() => closePanel('music')}
          disabled={disabled || busy} canPreview={canMixPreview && Boolean(musicPath) && validRange(range, duration)}
          playing={playerPlaying} onPreview={playMusicMix} onChange={changeMusic} onMixChange={changeMusicMix}
          onKainoCacheChange={refreshKainoTrack} imports={importedTracks} musicPath={musicPath}
          dropActive={dragging} onImport={importMusic} onRemoveImport={removeImportedMusic} />
        <BookendsMenu key={`bookends-${musicSourceRevision}`} project={projectBookends}
          clip={selectedClip ? { bookends: selectedClip.bookends, title: selectedClip.title || 'Selected clip' } : null}
          open={panel === 'bookends'} onClose={() => closePanel('bookends')}
          aspect={activeFormat.aspect} disabled={disabled || busy} videoExtensions={EXTENSIONS} onChange={changeBookend}
          canPreview={Boolean(sequenceKey && validRange(range, duration))} onPreview={playSequence} />
        <TextMenu open={panel === 'text'} onClose={() => closePanel('text')}
          label={selectedClip?.title || captionLabel} disabled={disabled || busy}
          overlays={activeTexts} entries={textEntries} selectedId={selectedText?.id ?? null} format={format}
          onSelect={setSelectedTextId} onJump={jumpToText} onAdd={addText} onChange={saveText} onRemove={removeText}
          onApplyAll={applyTextToAll} canApplyAll={clips.length > 0} />

        <section className="timeline" aria-label="Timeline">
          <div className="timeline-heading">
            <button className="icon-button compact boxed" title="Undo (Ctrl Z)" aria-label="Undo" disabled={!canUndo} onClick={undoEdit}><Undo2 size={15} /></button>
            <button className="icon-button compact boxed" title="Redo (Ctrl Shift Z)" aria-label="Redo" disabled={!canRedo} onClick={redoEdit}><Redo2 size={15} /></button>
            <span className="divider" />
            <button className="button outline small trim-section" disabled={!canTrim}
              title="Remove the In–Out selection from the video and close the gap" onClick={trimSection}><ScissorsLineDashed size={14} /> Delete range</button>
            <div className="trim-bar" role="group" aria-label="Trim range">
              <TimeField label="In" value={range.start} disabled={trimDisabled} onChange={value => editBoundary('start', value)} onMark={() => editBoundary('start', activeTime())} />
              <TimeField label="Out" value={range.end} disabled={trimDisabled} onChange={value => editBoundary('end', value)} onMark={() => editBoundary('end', activeTime())} />
              <span className="range-duration">{canSaveRange ? clipDuration(range.end - range.start) : ''}</span>
              <button className="icon-button compact" title="Reset trim range" aria-label="Reset trim range" onClick={resetRange} disabled={trimDisabled}><RotateCcw size={14} /></button>
              <button className="button primary small" disabled={!selectedLocked && (trimDisabled || !canSaveRange || editingCaptionJob)}
                title={selectedLocked ? 'New clip' : 'Add clip (Enter)'}
                onClick={selectedLocked ? resetRange : addClip}><Plus size={14} /> {selectedLocked ? 'New clip' : 'Add clip'}</button>
            </div>
            <div className="timeline-zoom" role="group" aria-label="Timeline zoom">
              <button className="icon-button compact" aria-label="Zoom out timeline" title="Zoom out (Ctrl -)"
                disabled={disabled || timelineZoom === 1} onClick={() => zoomTimelineTo(timelineZoom / 2)}><ZoomOut size={15} /></button>
              <input type="range" aria-label="Timeline zoom" min={0} max={ZOOM_STEPS.length - 1} step={1} value={zoomLevel} disabled={disabled}
                onChange={event => zoomTimelineTo(ZOOM_STEPS[event.target.valueAsNumber])} />
              <button className="icon-button compact" aria-label="Zoom in timeline" title="Zoom in (Ctrl +)"
                disabled={disabled || timelineZoom === MAX_TIMELINE_ZOOM} onClick={() => zoomTimelineTo(timelineZoom * 2)}><ZoomIn size={15} /></button>
              <button className="button outline small" aria-label="Fit entire timeline" title="Fit entire timeline (Ctrl 0)"
                disabled={disabled || timelineZoom === 1} onClick={() => zoomTimelineTo(1)}>Fit</button>
            </div>
          </div>
          <div className="timeline-grid">
            <div className="lane-labels" aria-hidden="true"><span>Time</span><span>Video</span><span>Captions</span><span>Music</span></div>
            <div className="timeline-body" ref={timelineBody}>
              <div className={`ruler ${hasSource ? 'seekable' : ''}`} aria-hidden="true" onPointerDown={seekFromRuler}>{[0, 1, 2, 3, 4, 5].map(step => <span key={step}>{duration
                ? stamp(timelineTime(visibleTime.start, visibleTime.span, step / 5), visibleTime.span < 5)
                : step === 0 ? '00:00:00' : ''}</span>)}</div>
              <div className="clip-labels">
                {clips.map((clip, index) => ({ clip, index, part: clipSegments(clip).find(segment => segment.end > visibleTime.start && segment.start < visibleTime.end) }))
                  .filter(item => item.part).map(({ clip, index, part }) => {
                    // The label is exactly as wide as the part of the clip on screen, so it never covers its neighbours.
                    const left = pct(Math.max(part!.start, visibleTime.start))
                    const width = pct(Math.min(part!.end, visibleTime.end)) - left
                    return <button key={clip.id} data-clip-id={clip.id} className={`clip-label${clip.id === selectedId ? ' selected' : ''}`}
                      disabled={disabled} aria-pressed={clip.id === selectedId} title={`${clipName(clip)} · ${clipDuration(clip.end - clip.start)} · ${stamp(clip.start, true)} – ${stamp(clip.end, true)}`}
                      style={{ left: `${left}%`, width: `calc(${Math.max(0, width)}% - 2px)`, '--clip-color': clipColor(clip.id) } as CSSProperties}
                      onClick={() => selectClip(clip)}><span className="clip-label-text">{String(index + 1).padStart(2, '0')} · {clipName(clip)} · {clipDuration(clip.end - clip.start)}</span></button>
                  })}
                {moments.filter(moment => moment.end > visibleTime.start && moment.start < visibleTime.end
                  && !clips.some(clip => clip.start === moment.start && clip.end === moment.end)).map(moment =>
                  <button key={momentKey(moment)} className="clip-label ghost" disabled={disabled}
                    title={`Suggestion · ${moment.text}`}
                    style={{ left: `${pct(Math.max(moment.start, visibleTime.start))}%`, width: `calc(${Math.max(0, pct(Math.min(moment.end, visibleTime.end)) - pct(Math.max(moment.start, visibleTime.start)))}% - 2px)` }}
                    onClick={() => previewMoment(moment)}><Sparkles size={11} /><span className="clip-label-text">#{moments.indexOf(moment) + 1} · {moment.text}</span></button>)}
              </div>
              <div className={`track ${hasSource ? 'loaded' : ''} ${grabbingTimeline ? 'grabbing' : ''}`} ref={track}
                onPointerDown={startTrackDrag} onPointerMove={moveTrackDrag} onPointerUp={finishTrackDrag}
                onLostPointerCapture={() => { timelineDrag.current = null; setGrabbingTimeline(false) }}>
                {hasSource ? (
                  <>
                    <div className="filmstrip" aria-hidden="true">{filmTiles.map(tile => {
                      const overview = overviewTiles[Math.min(9, Math.floor(tile.time / duration * 10))]
                      const frame = frames[tile.time] || frames[overview?.time]
                      return <div className="frame-tile" key={tile.index} style={{ left: `${tile.left}%` }}>
                        {frame && <img draggable={false} alt="" src={frame} />}
                      </div>
                    })}</div>
                    {clips.flatMap(clip => clipSegments(clip).map((segment, index, all) => ({ clip, segment, index, all })))
                      .filter(({ segment }) => pct(segment.end) > pct(segment.start))
                      .map(({ clip, segment, index, all }) => <Fragment key={`${clip.id}-${index}`}>
                        <div className={`clip-box ${clip.id === selectedId ? 'selected' : ''}`}
                          style={{ left: `${pct(segment.start)}%`, width: `${pct(segment.end) - pct(segment.start)}%`, '--clip-color': clipColor(clip.id) } as CSSProperties} />
                        {index > 0 && inView(segment.start) && <div className="cut-notch" title="Cut point — this part is skipped on export"
                          style={{ left: `${pct(all[index - 1].end)}%`, borderColor: clipColor(clip.id) }} />}
                      </Fragment>)}
                    {overlaps.map(overlap => pct(overlap.end) > pct(overlap.start) && <div key={overlap.start} className="overlap-line"
                      title="Overlapping clips" style={{ left: `${pct(overlap.start)}%`, width: `${pct(overlap.end) - pct(overlap.start)}%` }} />)}
                    {deletedRanges.map(gap => pct(gap.end) > pct(gap.start) && <div key={`deleted-${gap.start}`}
                      className="deleted-range" title="Removed from the video"
                      style={{ left: `${pct(gap.start)}%`, width: `${pct(gap.end) - pct(gap.start)}%` }} />)}
                    <div className="range-shade" style={{ width: `${pct(range.start)}%` }} />
                    <div className="range-shade right" style={{ width: `${100 - pct(range.end)}%` }} />
                    <div className="selection" style={{ left: `${pct(range.start)}%`, width: `${pct(range.end) - pct(range.start)}%` }} />
                    {moments.filter(moment => pct(moment.end) > pct(moment.start) && !clips.some(clip => clip.start === moment.start && clip.end === moment.end)).map(moment =>
                      <div className="moment-mark" key={momentKey(moment)} aria-hidden="true"
                        style={{ left: `${pct(moment.start)}%`, width: `${pct(moment.end) - pct(moment.start)}%` }} />)}
                    {[...new Set(sections.flatMap(section => [section.start, section.end]))].filter(point => point > 0 && point < duration && inView(point)).map(point =>
                      <div className="section-mark" key={point} style={{ left: `${pct(point)}%` }} />)}
                    {(['start', 'end'] as const).filter(edge => inView(range[edge])).map(edge => <button key={edge} className={`handle ${edge}`} disabled={trimDisabled}
                      aria-label={edge === 'start' ? 'Drag trim start' : 'Drag trim end'}
                      data-tight={pct(range.end) - pct(range.start) < 5}
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
                    {selectedClip && !selectedLocked && !busy && (['start', 'end'] as const)
                      .filter(side => inView(selectedClip[side])).map(side => <button key={`clip-${side}`}
                        className={`handle clip-edge ${side}`} aria-label={`Drag clip ${side} to trim`}
                        title={`Drag to trim the clip's ${side}`}
                        style={{ left: `clamp(0px, calc(${pct(selectedClip[side])}% - ${side === 'end' ? 11 : 0}px), calc(100% - 11px))` }}
                        onPointerDown={event => startClipEdgeDrag(event, selectedClip, side)}
                        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveClipEdgeDrag(event) }}
                        onLostPointerCapture={() => { clipEdgeDrag.current = null }}><span /></button>)}
                    <TimelinePlayhead pct={pct} inView={inView} onDrag={startPlayheadDrag}
                      onMove={event => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event, undefined, playheadOffset.current)
                      }} />
                  </>
                ) : <span className="empty-track"><Film size={16} /> Open a video to see its frames here</span>}
              </div>
              <div className="lane sound-lane" title={hasSource ? soundPeaks.length ? 'The video’s own sound' : 'This video has no sound' : undefined}>
                {hasSource && <SoundLane peaks={soundPeaks} duration={duration} view={visibleTime} range={range}
                  highlight={Boolean(selectedClip || reviewed || range.start > 0 || range.end < duration)} />}
              </div>
              <WordsLane cues={transcript} viewStart={visibleTime.start} viewEnd={visibleTime.end}
                rangeStart={range.start} rangeEnd={range.end}
                highlight={Boolean(selectedClip || reviewed || range.start > 0 || range.end < duration)}
                hasSource={hasSource} disabled={disabled} listening={listening}
                onSeek={seek} onListen={listenToVideoStable} />
              <div className="lane music-lane">
                {musicMarks.length ? musicMarks.filter(mark => pct(mark.end) > pct(mark.start)).map(mark =>
                  <button key={mark.key} data-clip-id={mark.clip.id} className={`music-mark${mark.own ? ' own' : ''}${mark.clip.id === selectedId ? ' selected' : ''}`}
                    disabled={disabled} style={{ left: `${pct(mark.start)}%`, width: `${pct(mark.end) - pct(mark.start)}%`, '--clip-color': clipColor(mark.clip.id) } as CSSProperties}
                    title={`${clipName(mark.clip)} · ${mark.name} · ${mark.own ? 'music for this clip' : 'music for all clips'}`}
                    onClick={() => { selectClip(mark.clip); togglePanel('music') }}>
                    {mark.first && <><Music2 size={11} /> {mark.name}</>}
                  </button>)
                : activeMusic && musicPath ? <>
                  <Waveform className="music-lane-wave" readOnly path={musicPath} duration={0} position={0} inPoint={0} onInPoint={() => {}} />
                  <button className="lane-tag" onClick={() => togglePanel('music')}><Music2 size={12} /> {musicTrack ? musicTrackName(musicTrack) : 'Music'} · {activeMusic.volume}%</button>
                </> : hasSource && <button className="lane-empty" disabled={disabled} onClick={() => togglePanel('music')}><Plus size={13} /> Add music</button>}
              </div>
              {source && <AccessibleScrubber duration={duration} seek={seek} />}
            </div>
          </div>
          {timelineZoom > 1 && <div ref={timelineScroll} className="timeline-pan" data-scrollbar="always" tabIndex={0} aria-label="Scroll timeline"
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
          <footer className="timeline-status" role="status">
            <span aria-hidden="true" className={`status-dot ${backgroundStatus ? 'active' : notice ? 'error' : ''}`} />
            <span className={`status-text${notice && !backgroundStatus ? ' error' : ''}`} title={status}>{backgroundStatus || notice || editStatus || hint}</span>
            {notice && !backgroundStatus && <button className="icon-button compact" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={13} /></button>}
          </footer>
        </section>
      </main>

      <ContextMenu menu={contextMenu} onClose={closeContextMenu} />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ExportDialog open={exportOpen} items={exportItems} checked={checkedExports} aspect={activeFormat.aspect}
        selectedId={selectedClip?.id ?? null} format={draftFormat} quality={draftQuality} folder={exportFolder}
        fileNameParts={preferences.fileNameParts} running={busy} canceling={cancelingExport} summary={summary ?? null}
        onClose={() => setExportOpen(false)}
        onToggle={id => setExportChecked(() => {
          const next = new Set(checkedExports)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })}
        onCheckAll={ids => setExportChecked(new Set(ids))}
        onFormat={setFormat} onQuality={setQuality}
        onChangeFolder={() => void chooseExportFolder()} onExport={startExport} onCancel={cancelExport}
        onShowFolder={() => void invoke('open_export_folder').catch(error => setNotice(message(error)))}
        onAddCaptions={addCaptionsFor} />
      {shortcuts && <div className="modal-backdrop" onClick={() => setShortcuts(false)}>
        <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={event => event.stopPropagation()}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setShortcuts(false) } }}>
          <div className="section-title"><h2 className="display-title">Keyboard shortcuts</h2><button autoFocus className="icon-button" aria-label="Close shortcuts" onClick={() => setShortcuts(false)}><X size={18} /></button></div>
          <dl>{SHORTCUTS.map(([label, key]) =>
            <div key={label}><dt>{label}</dt><dd><Key>{key}</Key></dd></div>)}</dl>
        </section>
      </div>}
    </div>
  )
}
