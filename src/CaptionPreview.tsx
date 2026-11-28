import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, RefObject } from 'react'
import { captionDimensions, captionLayouts, captionPoint, captionSequence, renderCaptionSprite } from './caption-artwork'
import { captionAt } from './captions'
import { playbackClock, useEditor } from './editor-store'
import type { CaptionFormat, CaptionState, CaptionStyle, CaptionTrack } from './captions'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const handles = [
  ['top left', -1, -1], ['top', 0, -1], ['top right', 1, -1],
  ['left', -1, 0], ['right', 1, 0],
  ['bottom left', -1, 1], ['bottom', 0, 1], ['bottom right', 1, 1],
] as const

export function CaptionPreview({ track, format, video, editable, onStyle }: {
  track: CaptionTrack; format: CaptionFormat; video: RefObject<HTMLVideoElement | null>
  editable: boolean; onStyle: (style: CaptionStyle) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const painting = useRef<CanvasRenderingContext2D | null>(null)
  const sprite = useRef<HTMLCanvasElement | null>(null)
  const [draft, setDraft] = useState<CaptionStyle | null>(null)
  const pending = useRef<CaptionStyle | null>(null)
  const style = draft ?? track.style
  const lastState = useRef<CaptionState | undefined>(undefined)
  const lastGuide = useRef<CaptionState | undefined>(undefined)
  const refreshPreview = useRef<((time: number) => void) | null>(null)
  const gesture = useRef<{ x: number; y: number; width: number; height: number; start: CaptionStyle;
    boxWidth: number; boxHeight: number; direction?: readonly [number, number] } | null>(null)
  const dimensions = useMemo(() => captionDimensions(format), [format])
  const states = useMemo(() => captionSequence(track.cues, style.mode ?? 'phrase', style.syncMs), [track.cues, style.mode, style.syncMs])
  const layoutFor = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d')
    return context && captionLayouts(context, track.cues, style, format)
  }, [track.cues, style, format])
  // Playback time is read from the store instead of subscribed to as React
  // state: while playing, frames are painted from requestVideoFrameCallback, so
  // re-rendering this component on every time tick did nothing but cost work.
  const clock = useRef(playbackClock.get())

  useLayoutEffect(() => {
    painting.current = canvas.current?.getContext('2d') ?? null
    sprite.current = document.createElement('canvas')
  }, [])

  useLayoutEffect(() => {
    const context = painting.current
    const player = video.current
    if (!context || !layoutFor) return
    const { width, height } = dimensions
    const paint = (position: number, force = false) => {
      const state = captionAt(states, position)
      const guide = editable && player?.paused && !state
        ? states.find(item => item.start >= position) ?? states.at(-1)
        : undefined
      const visible = state ?? guide
      if (!force && state === lastState.current && guide === lastGuide.current) return
      lastState.current = state
      lastGuide.current = guide
      context.clearRect(0, 0, width, height)
      const layout = visible && layoutFor(visible.cue)
      if (handle.current) {
        handle.current.hidden = !layout
        if (layout) {
          const { box } = layout
          Object.assign(handle.current.style, {
            left: `${100 * box.x / width}%`, top: `${100 * box.y / height}%`,
            width: `${100 * box.width / width}%`, height: `${100 * box.height / height}%`,
          })
        }
      }
      if (state && layout && sprite.current) {
        const ink = sprite.current.getContext('2d')
        if (ink) {
          renderCaptionSprite(sprite.current, ink, layout, state, style)
          context.drawImage(sprite.current, layout.box.x, layout.box.y)
        }
      }
    }
    paint(player && player.readyState > 0 ? player.currentTime : clock.current, true)
    refreshPreview.current = position => paint(position)
    if (!player) return
    const refresh = () => paint(player.currentTime, true)
    player.addEventListener('seeked', refresh)
    player.addEventListener('pause', refresh)
    player.addEventListener('play', refresh)
    if (!player.requestVideoFrameCallback) player.addEventListener('timeupdate', refresh)
    let frame = 0
    const next: VideoFrameRequestCallback = (_, { mediaTime }) => {
      paint(mediaTime)
      frame = player.requestVideoFrameCallback(next)
    }
    if (player.requestVideoFrameCallback) frame = player.requestVideoFrameCallback(next)
    return () => {
      player.removeEventListener('seeked', refresh)
      player.removeEventListener('pause', refresh)
      player.removeEventListener('play', refresh)
      player.removeEventListener('timeupdate', refresh)
      player.cancelVideoFrameCallback?.(frame)
      refreshPreview.current = null
    }
  }, [states, layoutFor, dimensions, editable, style, video])

  // While paused, a scrub or seek moves the clock without any video frame, so
  // repaint straight from the store when the time changes.
  useLayoutEffect(() => useEditor.subscribe((state, previous) => {
    if (state.time === previous.time) return
    clock.current = state.time
    const player = video.current
    if (player?.paused) refreshPreview.current?.(player.readyState > 0 ? player.currentTime : state.time)
  }), [video])

  const start = (event: PointerEvent<HTMLElement>, direction?: readonly [number, number]) => {
    if (event.button !== 0 || !canvas.current) return
    event.stopPropagation()
    video.current?.pause()
    const frame = canvas.current.getBoundingClientRect()
    const { width, height } = frame
    const rect = handle.current?.getBoundingClientRect()
    const point = rect ? { x: (rect.left - frame.left + rect.width / 2) / width,
      y: (rect.top - frame.top + rect.height / 2) / height } : captionPoint(track.style, format)
    gesture.current = { x: event.clientX, y: event.clientY, width, height,
      boxWidth: rect?.width || 1, boxHeight: rect?.height || 1, direction,
      start: { ...track.style, points: { ...track.style.points, [format]: point } } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = gesture.current
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.stopPropagation()
    const dx = (event.clientX - drag.x) / drag.width
    const dy = (event.clientY - drag.y) / drag.height
    let next: CaptionStyle
    if (drag.direction) {
      const [horizontal, vertical] = drag.direction
      const initial = drag.start.scale ?? (drag.start.size === 'small' ? 0.81 : drag.start.size === 'large' ? 1.25 : 1)
      const horizontalChange = horizontal * (event.clientX - drag.x) / drag.boxWidth
      const verticalChange = vertical * (event.clientY - drag.y) / drag.boxHeight
      const change = horizontal && vertical
        ? (horizontalChange * drag.boxWidth + verticalChange * drag.boxHeight) / (drag.boxWidth + drag.boxHeight)
        : horizontalChange + verticalChange
      const scale = clamp(initial * (1 + change), 0.55, 2)
      const point = captionPoint(drag.start, format)
      const growth = scale / initial - 1
      next = { ...drag.start, scale, points: { ...drag.start.points, [format]: {
        x: clamp(point.x + horizontal * growth * drag.boxWidth / drag.width / 2, 0, 1),
        y: clamp(point.y + vertical * growth * drag.boxHeight / drag.height / 2, 0, 1),
      } } }
    } else {
      const point = captionPoint(drag.start, format)
      next = { ...drag.start, points: { ...drag.start.points, [format]: {
        x: clamp(point.x + dx, 0, 1), y: clamp(point.y + dy, 0, 1),
      } } }
    }
    pending.current = next
    setDraft(next)
  }
  const stop = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    gesture.current = null
    if (pending.current) onStyle(pending.current)
    pending.current = null
    setDraft(null)
  }
  return <>
    <canvas ref={canvas} className="caption-artwork" {...dimensions} aria-hidden="true" />
    {editable && <div ref={handle} className="caption-bounds" hidden title="Drag captions to position" tabIndex={0}
      aria-label="Move captions with the arrow keys"
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key]
        if (!direction) return
        event.preventDefault()
        event.stopPropagation()
        const point = captionPoint(track.style, format)
        const step = event.shiftKey ? 0.05 : 0.01
        onStyle({ ...track.style, points: { ...track.style.points, [format]: {
          x: clamp(point.x + direction[0] * step, 0, 1), y: clamp(point.y + direction[1] * step, 0, 1),
        } } })
      }}
      onPointerDown={event => start(event)} onPointerMove={move} onPointerUp={stop} onLostPointerCapture={stop}>
      {handles.map(([label, x, y]) => <button key={label} type="button" className="caption-resize"
        data-x={x} data-y={y} tabIndex={x === 1 && y === 1 ? 0 : -1}
        aria-label={`Resize captions from ${label}`} title={`Resize from ${label}`}
        onPointerDown={event => start(event, [x, y])} onPointerMove={move} onPointerUp={stop} onLostPointerCapture={stop}
        onKeyDown={event => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          event.preventDefault()
          event.stopPropagation()
          const scale = track.style.scale ?? (track.style.size === 'small' ? 0.81 : track.style.size === 'large' ? 1.25 : 1)
          onStyle({ ...track.style, scale: clamp(scale + (event.key === 'ArrowRight' ? 0.05 : -0.05), 0.55, 2) })
        }} />)}
    </div>}
  </>
}
