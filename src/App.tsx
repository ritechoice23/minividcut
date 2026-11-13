import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import {
  ArrowDownToLine, ArrowUpRight, Check, ChevronDown, Clapperboard, Film, FolderOpen,
  Keyboard, LoaderCircle, Monitor, Move, Pause, Play, Plus, RotateCcw, Scissors, Smartphone,
  Split, Subtitles, Trash2, Volume2, VolumeX, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { cutRange, MAX_CLIPS, moveBoundary, parseTime, splitRange, stamp, trimClips, validRange } from './clip'
import type { Clip, Range } from './clip'
import { MAX_TIMELINE_ZOOM, panTimeline, timelineTime, timelineWindow, zoomTimeline } from './timeline'
import { CENTER, frameTravel, panPosition } from './framing'
import type { FramePosition, Framing } from './framing'
import { fileSize, summarizeExport } from './export-progress'
import type { ExportProgress, ExportState } from './export-progress'
import { CaptionEditor } from './CaptionEditor'
import { CaptionPreview } from './CaptionPreview'
import { prepareCaptionOverlay } from './caption-export'
import type { CaptionModel, CaptionProgress } from './CaptionEditor'
import { captionSlice, DEFAULT_CAPTION_STYLE, offsetCaption, restyleCaptionedClip } from './captions'
import type { CaptionCue, CaptionStyle, CaptionTrack } from './captions'

type VideoInfo = { path: string; name: string; duration: number; width: number; height: number }
type Format = 'landscape' | 'portrait'
type Quality = 'compact' | 'compatible' | 'lossless'
type ExportSettings = { format: Format; framing: Framing; position: FramePosition; quality: Quality }
type ExportBatch = { ranges: readonly Clip[]; states: ExportState[]; running: boolean; options: ExportSettings }

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
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [timelineStart, setTimelineStart] = useState(0)
  const timelinePanned = useRef(false)
  const timelineDrag = useRef<{ x: number; start: number; width: number; moved: boolean } | null>(null)
  const [grabbingTimeline, setGrabbingTimeline] = useState(false)
  const timelineBody = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [draftFormat, setFormat] = useState<Format>('landscape')
  const [draftQuality, setQuality] = useState<Quality>('compact')
  const [draftFraming, setFraming] = useState<Framing>('fill')
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
  const renameClick = useRef<number | null>(null)
  const [clipFrames, setClipFrames] = useState<Record<number, string>>({})
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const [captionModel, setCaptionModel] = useState<CaptionModel | null>(null)
  const [captionProgress, setCaptionProgress] = useState<CaptionProgress | null>(null)
  const [captionStatus, setCaptionStatus] = useState<{ key: string; text: string } | null>(null)
  const [draftCaptions, setDraftCaptions] = useState<Record<string, CaptionTrack | undefined>>({})
  const sharedCaptionStyle = useRef<CaptionStyle | null>(null)
  const captionButton = useRef<HTMLButtonElement>(null)
  const captionJob = useRef<{ key: string; cancelled: boolean } | null>(null)
  const frameCache = useRef(new Map<number, string>())
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const trimDrag = useRef<{ range: Range; offset: number } | null>(null)
  const playheadOffset = useRef(0)
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
  const batchIndices = new Map(exportBatch?.ranges.map((clip, index) => [clip.id, index]))
  const clipLocked = (id: number) => busy && batchIndices.has(id)
  const selectedLocked = selectedId !== null && clipLocked(selectedId)
  const lockedOptions = selectedLocked ? exportBatch?.options : undefined
  const format = lockedOptions?.format ?? draftFormat
  const framing = lockedOptions?.framing ?? draftFraming
  const quality = lockedOptions?.quality ?? draftQuality
  const activeFormat = FORMATS[format]
  const position = lockedOptions?.position ?? positions[format]
  const objectPosition = `${position.x}% ${position.y}%`
  const travel = previewAspect ? frameTravel(activeFormat.aspect, 1, previewAspect, framing) : { x: 0, y: 0 }
  const positionAxis = Math.abs(travel.x) > 0.001 ? 'x' : Math.abs(travel.y) > 0.001 ? 'y' : null
  const canPosition = Boolean(positionAxis && hasSource && !loading && !selectedLocked && preview !== 'preparing' && preview !== 'unavailable')
  const visibleTime = timelineWindow(duration, timelineZoom, timelineStart)
  const pct = (value: number) => visibleTime.span
    ? Math.max(0, Math.min(100, 100 * (value - visibleTime.start) / visibleTime.span)) : 0
  const inView = (value: number) => value >= visibleTime.start - 0.000001 && value <= visibleTime.end + 0.000001
  const zoomTimelineTo = (zoom: number) => {
    timelinePanned.current = false
    setTimelineZoom(zoom)
    setTimelineStart(zoomTimeline(duration, zoom, time))
  }
  const revealTimelineTime = (point: number) => {
    timelinePanned.current = false
    if (!inView(point)) setTimelineStart(zoomTimeline(duration, timelineZoom, point))
  }

  useEffect(() => {
    if (timelinePanned.current) return
    setTimelineStart(start => {
      const visible = timelineWindow(duration, timelineZoom, start)
      if (time >= visible.start - 0.000001 && time <= visible.end + 0.000001) return start
      return zoomTimeline(duration, timelineZoom, time)
    })
  }, [duration, timelineZoom, time])

  useEffect(() => {
    const body = timelineBody.current
    if (!body || timelineZoom === 1) return
    const scrollTimeline = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || (event.target instanceof Element && event.target.closest('input'))) return
      const delta = event.deltaX || event.deltaY
      if (!delta || !body.clientWidth) return
      event.preventDefault()
      timelinePanned.current = true
      const pixels = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * body.clientWidth : delta
      setTimelineStart(start => panTimeline(duration, timelineZoom, start, pixels / body.clientWidth))
    }
    body.addEventListener('wheel', scrollTimeline, { passive: false })
    return () => body.removeEventListener('wheel', scrollTimeline)
  }, [duration, timelineZoom])
  const selectedClip = clips.find(clip => clip.id === selectedId)
  const reviewed = reviewIndex === null ? undefined : sections[reviewIndex]
  const captionKey = selectedClip ? `clip-${selectedClip.id}` : reviewed ? `section-${reviewed.start}-${reviewed.end}` : 'range'
  const currentCaptions = selectedClip ? selectedClip.captions : draftCaptions[captionKey]
  const activeCaptions = useMemo(() => captionSlice(currentCaptions, range), [currentCaptions, range])
  const captionsRunning = captionProgress !== null
  const hasDraftCaptions = Object.values(draftCaptions).some(track => track?.cues.length)

  const loadVideo = useCallback(async (path: string) => {
    if (exportLock.current || importLock.current) return
    importLock.current = true
    try {
      if ((clips.length || hasDraftCaptions) &&
        !await confirm('Opening a different video clears the clips and captions for this video.', {
        title: 'Replace video?', kind: 'warning', okLabel: 'Replace video',
      })) return
      setLoading(true)
      setNotice('')
      const info = await invoke<VideoInfo>('open_video', { path })
      const request = ++sourceRequest.current
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
      setPositions({ landscape: CENTER, portrait: CENTER })
      setRange({ start: 0, end: info.duration })
      setTime(0)
      timelinePanned.current = false
      setTimelineZoom(1)
      setTimelineStart(0)
      setPlaying(false)
      setClips([])
      setSections([])
      setReviewIndex(null)
      setRenaming(null)
      frameCache.current.clear()
      setClipFrames({})
      setSelectedId(null)
      setCaptionsOpen(false)
      setCaptionStatus(null)
      setDraftCaptions({})
      sharedCaptionStyle.current = null
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
  }, [clips.length, hasDraftCaptions])

  const clipStarts = [...new Set(clips.map(clip => clip.start))].join(',')
  useEffect(() => {
    if (!source || !clipStarts) return
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
  }, [source, clipStarts])

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

  const seek = useCallback((position: number) => {
    if (!source) return
    const next = Math.min(duration, Math.max(0, position))
    const player = video.current
    if (player && player.readyState > 0) player.currentTime = Math.min(next, player.duration)
    setTime(next)
  }, [source, duration])

  const refreshCaptionModel = useCallback(async () => {
    const info = await invoke<CaptionModel>('caption_model')
    setCaptionModel(info)
  }, [])

  const openCaptions = () => {
    setCaptionsOpen(true)
    void refreshCaptionModel().catch(error => setCaptionStatus({ key: captionKey, text: message(error) }))
  }

  const closeCaptions = useCallback(() => {
    setCaptionsOpen(false)
    captionButton.current?.focus()
  }, [])

  const saveCaptions = useCallback((track: CaptionTrack) => {
    if (selectedId === null) setDraftCaptions(current => ({ ...current, [captionKey]: track }))
    else setClips(items => items.map(clip => clip.id === selectedId ? { ...clip, captions: track } : clip))
    setCaptionStatus(current => current?.key === captionKey ? null : current)
  }, [selectedId, captionKey])

  const saveCaptionStyle = useCallback((style: CaptionStyle) => {
    if (currentCaptions) saveCaptions({ ...currentCaptions, style })
  }, [currentCaptions, saveCaptions])

  const applyCaptionStyle = useCallback((style: CaptionStyle) => {
    if (exportLock.current || importLock.current || captionJob.current) return false
    sharedCaptionStyle.current = style
    setClips(items => items.map(clip => restyleCaptionedClip(clip, style)))
    setDraftCaptions(items => Object.fromEntries(Object.entries(items).map(([key, track]) =>
      [key, track && { ...track, style }])))
    return true
  }, [])

  const generateCaptions = useCallback(async () => {
    if (!source || !captionModel || captionJob.current || exportLock.current || importLock.current || !validRange(range, duration)) return
    const job = { key: captionKey, cancelled: false }
    captionJob.current = job
    const request = sourceRequest.current
    try {
      if (activeCaptions?.cues.length && !await confirm('Generate a new transcript and replace the captions for this shot?', {
        title: 'Regenerate captions?', okLabel: 'Regenerate',
      })) return
      if (request !== sourceRequest.current) return
      setCaptionStatus(null)
      setCaptionProgress({ stage: 'starting' })
      const progress = new Channel<CaptionProgress>()
      progress.onmessage = update => {
        if (captionJob.current === job && !job.cancelled) setCaptionProgress(update)
      }
      const cues = await invoke<CaptionCue[]>('generate_captions', {
        request: { path: source.path, range: { start: range.start, end: range.end }, allowDownload: !captionModel.installed },
        progress,
      })
      if (job.cancelled || request !== sourceRequest.current) return
      if (cues.length) saveCaptions({
        style: activeCaptions?.style ?? sharedCaptionStyle.current ?? { ...DEFAULT_CAPTION_STYLE, mode: 'highlight', font: 'Segoe UI' },
        cues: cues.map(cue => offsetCaption(cue, range.start)),
      })
      else setCaptionStatus({ key: captionKey, text: 'No speech detected in this shot.' })
    } catch (error) {
      if (!job.cancelled && request === sourceRequest.current) setCaptionStatus({ key: captionKey, text: message(error) })
    } finally {
      captionJob.current = null
      setCaptionProgress(null)
      void refreshCaptionModel().catch(() => {})
    }
  }, [source, captionModel, range, duration, captionKey, activeCaptions, refreshCaptionModel, saveCaptions])

  const cancelCaptions = useCallback(() => {
    const job = captionJob.current
    if (!job) return
    job.cancelled = true
    setCaptionProgress({ stage: 'canceling' })
    void invoke('cancel_captions').catch(() => {})
  }, [])

  const captionSeek = useCallback((position: number) => {
    video.current?.pause()
    seek(position)
  }, [seek])

  const captionPlayhead = useCallback(() => video.current?.currentTime ?? range.start, [range.start])

  const togglePlay = () => {
    const player = video.current
    if (!player || player.readyState === 0 || !source) return
    if (!player.paused) {
      player.pause()
      return
    }
    const from = player.currentTime
    const saved = selectedId === 0 ? exportBatch?.ranges.find(clip => clip.id === 0) : clips.find(clip => clip.id === selectedId)
    const reviewed = reviewIndex === null ? undefined : sections[reviewIndex]
    const previewed = saved ?? reviewed
    const playingSection = previewed?.start === range.start && previewed.end === range.end

    if (player.ended || (playingSection && from >= range.end - 0.005) || (!playingSection && from >= duration - 0.005)) {
      seek(playingSection ? range.start : 0)
    } else if (playingSection && from < range.start) {
      seek(range.start)
    }

    playUntil.current = playingSection ? range.end : null
    void player.play().catch(error => setNotice(message(error)))
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
    if (captionJob.current?.key === captionKey) return
    if (selectedId !== null) {
      setClips(items => items.map(clip => clip.id === selectedId ? {
        ...clip, start: range.start, end: range.end, captions: captionSlice(clip.captions, range),
      } : clip))
      setSelectedId(null)
      setCaptionsOpen(false)
      return
    }
    if (clips.length >= MAX_CLIPS) {
      setNotice(`A batch can contain up to ${MAX_CLIPS} clips.`)
      return
    }
    const clip = { start: range.start, end: range.end, id: nextId.current++, captions: activeCaptions }
    setClips(items => [...items, clip])
    if (activeCaptions) {
      setDraftCaptions(current => ({ ...current, [captionKey]: undefined }))
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
    if (captionJob.current?.key === captionKey) return
    if (!parts || parts.length < 2) {
      setNotice(parts ? 'Choose an interval shorter than the trim range.' : 'Choose a longer interval to create at most 100 sections.')
      return
    }
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
      const title = replaced < 0 ? undefined : clips[replaced].title
      return { ...part, id: nextId.current++, title: title ? `${title} - Part ${index + 1}` : undefined, captions: captionSlice(activeCaptions, part) }
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
    revealTimelineTime(clip.start)
    seek(clip.start)
  }

  const trimSection = () => {
    if (selectedLocked || !validRange(range, duration) || captionJob.current?.key === captionKey) return
    if (sections.length > 0) {
      const overlapping = sections.filter(sec => range.start < sec.end && range.end > sec.start)
      if (!overlapping.length) return

      const remaining: Range[] = []
      for (const sec of sections) {
        if (range.start < sec.end && range.end > sec.start) {
          remaining.push(...cutRange(sec, range))
        } else {
          remaining.push(sec)
        }
      }

      if (remaining.length > MAX_CLIPS) {
        setNotice(`Keep at most ${MAX_CLIPS} marked sections.`)
        return
      }

      if (currentCaptions) {
        setDraftCaptions(current => {
          const updated = { ...current, [captionKey]: undefined }
          for (const sec of overlapping) {
            for (const part of cutRange(sec, range)) {
              updated[`section-${part.start}-${part.end}`] = captionSlice(currentCaptions, part)
            }
          }
          return updated
        })
      }

      setSections(remaining)
      if (remaining.length) {
        const nextIndex = Math.min(reviewIndex ?? 0, remaining.length - 1)
        reviewSection(remaining, nextIndex)
      } else {
        setReviewIndex(null)
        resetRange()
        video.current?.pause()
      }
      setNotice('')
      return
    }

    const trimmed = trimClips(clips, range, duration, () => nextId.current++, captionSlice)
    if (trimmed.length > MAX_CLIPS) {
      setNotice(`Keep at most ${MAX_CLIPS} clips.`)
      return
    }

    setClips(trimmed)
    setCaptionsOpen(false)

    if (trimmed.length) {
      const stillSelected = selectedId !== null && trimmed.find(clip => clip.id === selectedId)
      if (stillSelected) {
        selectClip(stillSelected)
      } else {
        const oldIndex = clips.findIndex(clip => clip.id === selectedId)
        const nextIndex = oldIndex >= 0 ? Math.min(oldIndex, trimmed.length - 1) : 0
        selectClip(trimmed[nextIndex])
      }
    } else {
      resetRange()
      video.current?.pause()
    }
    setNotice('')
  }

  const renameClip = (id: number, title: string) => {
    if (clipLocked(id)) return
    const cleaned = title.trim()
    setClips(items => items.map(clip => clip.id === id && (clip.title ?? '') !== cleaned
      ? { ...clip, title: cleaned || undefined } : clip))
    setRenaming(null)
  }

  const exportVideos = async (only?: Clip) => {
    if (!source || exportLock.current || importLock.current || fileDialog.current || captionJob.current) return
    if (!clips.length && sections.length) return
    const batch = only ? [only] : clips.length ? clips : [{ ...range, id: 0, captions: activeCaptions }]
    const options = { format: draftFormat, framing: draftFraming, position: positions[draftFormat], quality: draftQuality }
    if (!batch.every(clip => validRange(clip, duration))) return
    exportLock.current = true
    setNotice('')
    const request = ++exportRequest.current
    let started = false
    const overlays: string[] = []
    try {
      const folder = await open({ directory: true, title: 'Choose where to save your clips' })
      if (!folder) return
      started = true
      setCaptionsOpen(false)
      setExportBatch({ ranges: batch, states: batch.map(() => ({ status: 'queued' })), running: true, options })
      const hasCaptionArtwork = batch.some(clip => clip.captions?.cues.some(cue => cue.text.trim()))
      if (hasCaptionArtwork) setNotice('Preparing caption artwork…')
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
      const prepared = []
      for (const clip of batch) {
        const captions = captionSlice(clip.captions, clip, true)
        const captionOverlay = captions && await prepareCaptionOverlay(captions, options.format, clip.end - clip.start)
        if (captionOverlay) overlays.push(captionOverlay)
        prepared.push({ start: clip.start, end: clip.end, title: clip.title, captionOverlay })
      }
      if (hasCaptionArtwork) setNotice('')
      const states = await invoke<ExportState[]>('export_clips', {
        path: source.path, folder, clips: prepared,
        options, progress: channel,
      })
      setExportBatch({ ranges: batch, states, running: false, options })
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
      exportLock.current = false
    }
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
      const key = event.key.toLowerCase()
      const target = event.target instanceof Element ? event.target : null

      if (event.key === 'Escape') {
        if (captionsOpen && target?.closest('#caption-editor') && !target.closest('input, select, textarea')) closeCaptions()
        setShortcuts(false)
        setSplitOpen(false)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'o') {
        event.preventDefault()
        void chooseVideo()
        return
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === '+' || key === '=' || event.code === 'NumpadAdd') {
          event.preventDefault()
          if (source && !loading) zoomTimelineTo(timelineZoom * 2)
          return
        }
        if (key === '-' || key === '_' || event.code === 'NumpadSubtract') {
          event.preventDefault()
          if (source && !loading) zoomTimelineTo(timelineZoom / 2)
          return
        }
        if (key === '0' || event.code === 'Numpad0') {
          event.preventDefault()
          if (source && !loading) zoomTimelineTo(1)
          return
        }
      }

      if (shortcuts) return

      if (key === ' ' || event.code === 'Space') {
        if (!isTextEditing(target)) {
          event.preventDefault()
          if (source && !loading) togglePlay()
          return
        }
      }

      if (isTextEditing(target) || event.ctrlKey || event.metaKey || event.altKey || !source || loading) return
      if (key === 'i' || key === 'o') {
        editBoundary(key === 'i' ? 'start' : 'end', time)
        return
      }
      if (key === 'arrowleft' || key === 'arrowright') {
        if (!target?.closest('input[type="range"]')) {
          event.preventDefault()
          seek(time + (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 5 : 1))
        }
        return
      }
      if (key === 'enter' && !event.repeat) {
        if (!target?.closest('button, a, input, select, textarea')) addClip()
      }
    }
    window.addEventListener('keydown', shortcutsHandler)
    return () => window.removeEventListener('keydown', shortcutsHandler)
  })

  const scrub = (event: ReactPointerEvent, edge?: keyof Range, offset = 0) => {
    if (!track.current || !source || loading || (edge && selectedLocked)) return
    const rect = track.current.getBoundingClientRect()
    const pointer = timelineTime(visibleTime.start, visibleTime.span, (event.clientX - rect.left - offset) / rect.width)
    const drag = edge ? trimDrag.current : null
    const time = Math.max(0, Math.min(duration, pointer - (drag?.offset ?? 0)))
    if (edge && drag) editBoundary(edge, time, drag.range)
    seek(time)
  }

  const startScrub = (event: ReactPointerEvent, edge?: keyof Range) => {
    if (!source || !track.current || loading || (edge && selectedLocked) || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    video.current?.pause()
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
    const rect = track.current.getBoundingClientRect()
    playheadOffset.current = event.clientX - rect.left - pct(time) * rect.width / 100
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
    if (!drag.moved && Math.abs(delta) < 4) return
    drag.moved = true
    setGrabbingTimeline(true)
    timelinePanned.current = true
    setTimelineStart(panTimeline(duration, timelineZoom, drag.start, delta / drag.width))
  }

  const finishTrackDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (timelineDrag.current && !timelineDrag.current.moved && event.currentTarget.hasPointerCapture(event.pointerId)) {
      video.current?.pause()
      scrub(event)
    }
  }

  const disabled = !hasSource || loading
  const trimDisabled = disabled || selectedLocked
  const canSaveRange = validRange(range, duration)
  const editingCaptionJob = captionsRunning && captionJob.current?.key === captionKey
  const canTrim = !trimDisabled && canSaveRange && !editingCaptionJob && (
    sections.length > 0
      ? sections.some(sec => range.start < sec.end && range.end > sec.start)
      : clips.length > 0
        ? clips.some(clip => range.start < clip.end && range.end > clip.start)
        : (range.start > 0 || range.end < duration)
  )
  const batchCount = clips.length || (hasSource && !sections.length ? 1 : 0)
  const summary = exportBatch && summarizeExport(exportBatch.ranges, exportBatch.states)
  const singleExport = busy ? exportBatch?.ranges.find(clip => clip.id === 0) : undefined
  const displayedClips = singleExport ? [singleExport, ...clips] : clips
  const captionLabel = selectedClip ? selectedClip.title || `Clip ${clips.indexOf(selectedClip) + 1}`
    : reviewed ? `Section ${(reviewIndex ?? 0) + 1}` : 'Current range'
  const showCaptionEditor = captionsOpen && !trimDisabled && canSaveRange

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Scissors size={19} /></span><span>MiniVidCut</span></div>
        <div className="top-actions">
          <button className="icon-button shortcuts-button" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => setShortcuts(true)}><Keyboard size={19} /></button>
          <button className="button outline" onClick={() => void chooseVideo()} disabled={busy || loading}><FolderOpen size={16} /> Open video <Key>Ctrl O</Key></button>
          <button className="button primary export" onClick={() => void exportVideos()} disabled={disabled || busy || captionsRunning || renaming !== null || !batchCount || (!clips.length && !canSaveRange)}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={17} />}
            {busy ? `Exporting ${summary?.percent ?? 0}%` : batchCount ? `Export ${batchCount} ${batchCount === 1 ? 'clip' : 'clips'}` : 'Export'}
          </button>
        </div>
      </header>

      <main className={`workspace ${sections.length ? 'reviewing' : ''} ${timelineZoom > 1 ? 'timeline-zoomed' : ''}`}>
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
                      preload="auto" playsInline style={{ objectPosition }}
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
                  {activeCaptions && activeCaptions.cues.length > 0 && preview !== 'preparing' && preview !== 'unavailable' &&
                    <CaptionPreview key={previewPath} track={activeCaptions} format={format} video={video} time={time}
                      editable={showCaptionEditor && !editingCaptionJob} onStyle={saveCaptionStyle} />}
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
            {hasSource && <button ref={captionButton} className={`icon-button caption-toggle${activeCaptions?.cues.length ? ' has-captions' : ''}`}
              title="Captions" aria-label="Captions" aria-expanded={showCaptionEditor} aria-controls={showCaptionEditor ? 'caption-editor' : undefined}
              disabled={trimDisabled || !canSaveRange} onClick={captionsOpen ? closeCaptions : openCaptions}>
              {captionsRunning ? <LoaderCircle size={17} className="spin" /> : <Subtitles size={18} />}
            </button>}
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
            <label className="file-size">
              <span>Export quality</span>
              <select value={quality} disabled={selectedLocked} onChange={event => setQuality(event.target.value as Quality)}>
                <option value="compact">Compact (H.265)</option>
                <option value="compatible">Compatible (H.264)</option>
                <option value="lossless">Lossless video (large)</option>
              </select>
            </label>
          </div>
        </section>

        {showCaptionEditor ? <CaptionEditor key={captionKey} label={captionLabel} range={range} track={activeCaptions}
          model={captionModel} progress={captionProgress} status={captionStatus?.key === captionKey ? captionStatus.text : ''}
          format={format} editing={editingCaptionJob} canApplyStyle={!busy && !captionsRunning}
          defaultStyle={sharedCaptionStyle.current ?? undefined} onApplyStyle={applyCaptionStyle}
          onChange={saveCaptions} onStyle={saveCaptionStyle} onGenerate={generateCaptions} onCancel={cancelCaptions}
          onClose={closeCaptions} onSeek={captionSeek} getTime={captionPlayhead} /> : <aside className="queue panel" aria-label="Clips">
          <div className="panel-heading">
            <div className="source-line"><Clapperboard size={16} /><h2>Clips</h2><span className="count">{displayedClips.length}</span></div>
            {selectedClip && !busy
              ? <button className="button outline small" disabled={disabled || captionsRunning || renaming !== null}
                onClick={() => void exportVideos(selectedClip)}><ArrowDownToLine size={13} /> Export selected</button>
              : displayedClips.length > 0 && <span className="queue-duration" title="Total clip duration">{stamp(displayedClips.reduce((total, clip) => total + clip.end - clip.start, 0), true)}</span>}
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
                  <span><strong>{title}</strong><small>{stamp(clip.start, true)} – {stamp(clip.end, true)}</small></span>
                </button>}
                {state && <ExportBadge state={state} />}
                {!locked && <button className="icon-button compact clip-remove" aria-label={`Remove clip ${index + 1}`} title="Remove clip" disabled={disabled || editing || captionJob.current?.key === `clip-${clip.id}`} style={{ visibility: editing ? 'hidden' : undefined }} onClick={() => {
                  setClips(items => items.filter(item => item.id !== clip.id))
                  if (selectedId === clip.id) setSelectedId(null)
                }}><Trash2 size={14} /></button>}
                {state?.status === 'encoding' && <div className="clip-meter" aria-hidden="true"><span style={{ width: `${state.fraction * 100}%` }} /></div>}
              </li>
            })}</ol>}
        </aside>}

        <section className="timeline panel" aria-label="Timeline">
          <div className="panel-heading timeline-heading">
            <div className="source-line"><Scissors size={17} /><span>Timeline</span></div>
            <div className="timeline-zoom" role="group" aria-label="Timeline zoom">
              <button className="icon-button compact" aria-label="Zoom out timeline" title="Zoom out"
                disabled={disabled || timelineZoom === 1} onClick={() => zoomTimelineTo(timelineZoom / 2)}><ZoomOut size={16} /></button>
              <button className="button outline small" aria-label="Fit entire timeline" title="Fit entire timeline"
                disabled={disabled || timelineZoom === 1} onClick={() => zoomTimelineTo(1)}>Fit</button>
              <button className="icon-button compact" aria-label="Zoom in timeline" title="Zoom in"
                disabled={disabled || timelineZoom === MAX_TIMELINE_ZOOM} onClick={() => zoomTimelineTo(timelineZoom * 2)}><ZoomIn size={16} /></button>
            </div>
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
            <div className="ruler" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(step => <span key={step}>{duration
              ? stamp(timelineTime(visibleTime.start, visibleTime.span, step / 5), visibleTime.span < 5)
              : step === 0 ? '00:00:00' : ''}</span>)}</div>
            <div className={`track ${hasSource ? 'loaded' : ''} ${grabbingTimeline ? 'grabbing' : ''}`} ref={track}
              onPointerDown={startTrackDrag} onPointerMove={moveTrackDrag} onPointerUp={finishTrackDrag}
              onLostPointerCapture={() => { timelineDrag.current = null; setGrabbingTimeline(false) }}>
              {hasSource ? (
                <>
                  <div className="filmstrip"><div className="frames" style={{
                    width: `${timelineZoom * 100}%`, left: `${-100 * visibleTime.start / visibleTime.span}%`,
                  }}>{Array.from({ length: 10 }, (_, index) => frames[index] ? <img draggable={false} alt="" key={index} src={frames[index]} /> : <span key={index} />)}</div></div>
                  <div className="range-shade" style={{ width: `${pct(range.start)}%` }} />
                  <div className="range-shade right" style={{ width: `${100 - pct(range.end)}%` }} />
                  <div className="selection" style={{ left: `${pct(range.start)}%`, width: `${pct(range.end) - pct(range.start)}%` }} />
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
                  {inView(time) && <div className="playhead" style={{ left: `${pct(time)}%` }}>
                    <span className="playhead-grip" title="Drag to seek" aria-hidden="true"
                      onPointerDown={startPlayheadDrag}
                      onPointerMove={event => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event, undefined, playheadOffset.current)
                      }} />
                  </div>}
                </>
              ) : <span className="empty-track"><Film size={16} /> Open a video to start trimming</span>}
            </div>
            {clips.length > 0 && <div className="clip-strip" aria-label="Saved clip ranges">
              {clips.map((clip, index) => clip.end > visibleTime.start && clip.start < visibleTime.end && <button key={clip.id} className={clip.id === selectedId ? 'selected' : ''}
                title={`Clip ${index + 1} · ${stamp(clip.start, true)} – ${stamp(clip.end, true)}`}
                aria-label={`Select clip ${index + 1} on timeline`} disabled={disabled}
                aria-pressed={clip.id === selectedId}
                style={{ left: `${pct(clip.start)}%`, width: `${pct(clip.end) - pct(clip.start)}%` }}
                onClick={() => selectClip(clip)} />)}
            </div>}
            {source && <input className="accessible-scrubber" aria-label="Playhead time" type="range" min={0} max={duration} step="any" value={time} onChange={event => seek(Number(event.target.value))} />}
          </div>
          {timelineZoom > 1 && <div className="timeline-pan">
            <input type="range" aria-label="Scroll timeline" title="Drag to scroll left or right"
              min={0} max={visibleTime.maxStart} step="any" value={visibleTime.start}
              aria-valuetext={stamp(visibleTime.start, true)}
              onChange={event => {
                timelinePanned.current = true
                setTimelineStart(Number(event.target.value))
              }} />
          </div>}
          <div className="trim-bar" role="group" aria-label="Trim range">
            <TimeField label="In" value={range.start} disabled={trimDisabled} onChange={value => editBoundary('start', value)} onMark={() => editBoundary('start', time)} />
            <TimeField label="Out" value={range.end} disabled={trimDisabled} onChange={value => editBoundary('end', value)} onMark={() => editBoundary('end', time)} />
            <button className="icon-button compact" title="Reset trim range" aria-label="Reset trim range" onClick={resetRange} disabled={trimDisabled}><RotateCcw size={15} /></button>
            {hasSource && <span className="range-duration" title={canSaveRange ? 'Trim range duration' : 'A clip must be at least 0.05 seconds long'}>{stamp(range.end - range.start, true)}</span>}
            <button className="button outline small trim-section cut-section" disabled={!canTrim}
              title="Trim the In–Out section and keep the remaining parts" onClick={trimSection}><Scissors size={14} /> Trim</button>
            {selectedLocked ? <button className="button add" onClick={resetRange}><Plus size={16} /> New clip</button> : <button className="button add" disabled={trimDisabled || !canSaveRange || editingCaptionJob} onClick={addClip}>{selectedId === null ? <Plus size={16} /> : <Check size={16} />}{selectedId === null ? 'Add clip' : 'Update clip'}</button>}
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
          <dl>{[['Open video', 'Ctrl O'], ['Play / pause', 'Space'], ['Zoom in', 'Ctrl +'], ['Zoom out', 'Ctrl -'], ['Fit timeline', 'Ctrl 0'], ['Seek 1 second', '← / →'], ['Seek 5 seconds', 'Shift ← / →'], ['Mark In', 'I'], ['Mark Out', 'O'], ['Add or update clip', 'Enter']].map(([label, key]) =>
            <div key={label}><dt>{label}</dt><dd><Key>{key}</Key></dd></div>)}</dl>
        </section>
      </div>}
    </div>
  )
}
