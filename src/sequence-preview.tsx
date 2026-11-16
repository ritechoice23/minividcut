import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { Range } from './clip'
import type { Bookends } from './bookends'
import type { CaptionTrack } from './captions'
import { captionAt, captionSlice } from './captions'
import { captionDimensions, captionLayouts, captionSequence, renderCaptionSprite } from './caption-artwork'
import type { FramePosition, Framing } from './framing'
import type { Music } from './music'
import { buildCompositionPlan, layerState, outroLayerState } from './sequence-plan'
import type { BookendMedia, CompositionPlan, Format, LayerState } from './sequence-plan'

export type Sequence = {
  path: string
  duration: number
  range: Range
  captions?: CaptionTrack
  music: Music | null
  musicPath: string
  muted: boolean
  bookends: Bookends
  options: { format: Format; framing: Framing; position: FramePosition }
}

export type SequenceController = {
  currentTime: number
  duration: number
  paused: boolean
  readyState: number
  volume: number
  muted: boolean
  play: () => Promise<void>
  pause: () => void
  seek: (time: number) => void
}

type BookendInfo = { image: boolean; path: string; name: string; duration?: number }

export function useSequencePreview(key: string, onError: (message: string) => void) {
  const [shown, setShown] = useState<string | null>(null)
  const [plan, setPlan] = useState<CompositionPlan | null>(null)
  const planRef = useRef<CompositionPlan | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [clock, setClock] = useState({ time: 0, duration: 0 })
  const [playing, setPlaying] = useState(false)

  const request = useRef(0)
  const keyRef = useRef(key)
  const raf = useRef(0)
  const lastFrame = useRef(0)
  const lastClock = useRef(0)
  const mainRef = useRef<HTMLVideoElement>(null)
  const introRef = useRef<HTMLMediaElement>(null)
  const outroRef = useRef<HTMLMediaElement>(null)
  const musicRef = useRef<HTMLAudioElement>(null)
  const captionRef = useRef<HTMLCanvasElement>(null)
  const visible = useRef({ intro: false, main: false, outro: false, music: false })
  const painter = useRef<((time: number, active: boolean) => void) | null>(null)
  const mediaCache = useRef(new Map<string, BookendMedia>())

  const player = useRef<SequenceController>({
    currentTime: 0, duration: 0, paused: true, readyState: 4, volume: 1, muted: false,
    play: async () => {}, pause: () => {}, seek: () => {},
  })

  const applyLayer = (element: HTMLMediaElement | null, state: LayerState, local: number,
    flag: 'intro' | 'main' | 'outro', image: boolean) => {
    if (!element) return
    element.hidden = !state.active
    if (!state.active) {
      if (visible.current[flag]) {
        if (!image) element.pause()
        visible.current[flag] = false
      }
      return
    }
    element.style.opacity = String(state.alpha)
    element.style.transform = state.slide ? `translateX(${state.slide}%)` : ''
    if (image) return
    if (!visible.current[flag] || Math.abs(element.currentTime - local) > 0.25) element.currentTime = local
    element.volume = state.alpha * player.current.volume
    element.muted = player.current.muted
    if (player.current.paused) element.pause()
    else if (!visible.current[flag] || element.paused) void element.play().catch(() => {})
    visible.current[flag] = true
  }

  const update = useCallback((current: CompositionPlan, time: number) => {
    const main = layerState('main', current, time)
    applyLayer(mainRef.current, main, main.local, 'main', false)
    if (current.intro) {
      const state = layerState(current.intro, current, time)
      applyLayer(introRef.current, state, state.local, 'intro', current.intro.image)
    }
    if (current.outro) {
      const state = outroLayerState(current, time)
      applyLayer(outroRef.current, state, state.local, 'outro', current.outro.image)
    }
    const audio = musicRef.current
    if (audio && current.music) {
      const local = audio.duration > 0 ? time % audio.duration : time
      audio.volume = current.music.volume / 100 * player.current.volume
      audio.muted = player.current.muted
      if (!visible.current.music || Math.abs(audio.currentTime - local) > 0.4) audio.currentTime = local
      if (player.current.paused) audio.pause()
      else if (audio.paused) void audio.play().catch(() => {})
      visible.current.music = true
    }
    painter.current?.(main.local, main.active)
  }, [])

  const pause = useCallback(() => {
    player.current.paused = true
    setPlaying(false)
    window.cancelAnimationFrame(raf.current)
    mainRef.current?.pause()
    introRef.current?.pause()
    outroRef.current?.pause()
    musicRef.current?.pause()
  }, [])

  const seek = useCallback((time: number) => {
    const current = planRef.current
    if (!current) return
    const value = Math.max(0, Math.min(current.total, time))
    player.current.currentTime = value
    update(current, value)
    setClock({ time: value, duration: current.total })
  }, [update])

  const play = useCallback(async () => {
    if (!plan) return
    if (player.current.currentTime >= plan.total - 0.001) seek(0)
    player.current.paused = false
    setPlaying(true)
    lastFrame.current = performance.now()
    window.cancelAnimationFrame(raf.current)
    const tick = (now: number) => {
      if (player.current.paused || !plan) return
      const step = Math.min(0.25, (now - lastFrame.current) / 1000)
      lastFrame.current = now
      let time = player.current.currentTime + step
      if (time >= plan.total) {
        time = plan.total
        player.current.pause()
      }
      player.current.currentTime = time
      update(plan, time)
      if (now - lastClock.current > 100) {
        lastClock.current = now
        setClock({ time, duration: plan.total })
      }
      if (!player.current.paused) raf.current = window.requestAnimationFrame(tick)
    }
    raf.current = window.requestAnimationFrame(tick)
  }, [plan, update, seek])

  player.current.play = play
  player.current.pause = pause
  player.current.seek = seek

  const stop = useCallback(() => {
    ++request.current
    pause()
    window.cancelAnimationFrame(raf.current)
    planRef.current = null
    player.current.currentTime = 0
    player.current.duration = 0
    visible.current = { intro: false, main: false, outro: false, music: false }
    painter.current = null
    setShown(null)
    setPlan(null)
    setPlaying(false)
    setPreparing(false)
    setClock({ time: 0, duration: 0 })
  }, [pause])

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key
      if (shown) stop()
    }
  }, [key, shown, stop])
  useEffect(() => stop, [stop])
  useEffect(() => {
    if (!shown) return
    const handle = window.requestAnimationFrame(() => { void player.current.play() })
    return () => window.cancelAnimationFrame(handle)
  }, [shown])

  const resolveMedia = async (end: NonNullable<Bookends['intro']>): Promise<BookendMedia> => {
    const cached = mediaCache.current.get(end.path)
    if (cached) return cached
    if (end.image) return { image: true, duration: end.duration ?? 2 }
    if (Number.isFinite(end.duration) && (end.duration ?? 0) > 0) {
      return { image: false, duration: end.duration! }
    }
    const info = await invoke<BookendInfo>('inspect_bookend', { path: end.path })
    const media = { image: info.image, duration: info.duration ?? end.duration ?? 0 }
    mediaCache.current.set(end.path, media)
    return media
  }

  async function start(sequence: Sequence, sequenceKey = key) {
    stop()
    const job = ++request.current
    setPreparing(true)
    try {
      const entries = await Promise.all(
        [sequence.bookends.intro, sequence.bookends.outro]
          .filter((end): end is NonNullable<typeof end> => Boolean(end))
          .map(async end => [end.path, await resolveMedia(end)] as const),
      )
      if (request.current !== job) return
      const media = Object.fromEntries(entries)
      const captions = captionSlice(sequence.captions, sequence.range, true)
      const next = buildCompositionPlan({
        path: sequence.path, range: sequence.range, bookends: sequence.bookends, media,
        format: sequence.options.format, framing: sequence.options.framing,
        position: sequence.options.position, captions, music: sequence.music,
        musicPath: sequence.musicPath, muted: sequence.muted,
      })
      preparePainter(captions, sequence.options.format)
      planRef.current = next
      player.current.currentTime = 0
      player.current.duration = next.total
      player.current.muted = next.muted
      setClock({ time: 0, duration: next.total })
      setPlan(next)
      setShown(sequenceKey || 'composite')
      setPreparing(false)
    } catch (error) {
      if (request.current === job) {
        onError(`Could not preview this clip. ${String(error)}`)
        setPreparing(false)
      }
    }
  }

  function preparePainter(track: CaptionTrack | undefined, format: Format) {
    painter.current = null
    if (!track?.cues.length) return
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const sprite = document.createElement('canvas')
    const ink = sprite.getContext('2d')
    if (!context || !ink) return
    const { width, height } = captionDimensions(format)
    const states = captionSequence(track.cues, track.style.mode ?? 'phrase', track.style.syncMs)
    const layoutFor = captionLayouts(context, track.cues, track.style, format)
    painter.current = (time, active) => {
      const surface = captionRef.current
      if (!surface) return
      if (surface.width !== width) {
        surface.width = width
        surface.height = height
      }
      const surfaceInk = surface.getContext('2d')
      if (!surfaceInk) return
      surfaceInk.clearRect(0, 0, width, height)
      if (!active) return
      const state = captionAt(states, time)
      if (!state) return
      const layout = layoutFor(state.cue)
      renderCaptionSprite(sprite, ink, layout, state, track.style)
      surfaceInk.drawImage(sprite, layout.box.x, layout.box.y)
    }
  }

  const stage: ReactNode = plan && shown ? (
    <div className="composite" aria-label="Full clip preview" onClick={() => player.current.pause()}>
      {plan.intro && <div className="composite-layer">
        {plan.intro.image
          ? <img ref={introRef as Ref<HTMLImageElement>} className="fit" style={{ objectPosition: layerPosition(plan) }}
              src={convertFileSrc(plan.intro.path)} alt="" draggable={false} />
          : <video ref={introRef as Ref<HTMLVideoElement>} className="fit" style={{ objectPosition: layerPosition(plan) }}
              src={convertFileSrc(plan.intro.path)} autoPlay playsInline preload="auto" />}
      </div>}
      <div className="composite-layer">
        <video ref={mainRef} className={plan.main.framing} style={{ objectPosition: `${plan.main.position.x}% ${plan.main.position.y}%` }}
          src={convertFileSrc(plan.main.path)} autoPlay playsInline preload="auto" />
      </div>
      {plan.outro && <div className="composite-layer">
        {plan.outro.image
          ? <img ref={outroRef as Ref<HTMLImageElement>} className="fit" style={{ objectPosition: layerPosition(plan, true) }}
              src={convertFileSrc(plan.outro.path)} alt="" draggable={false} />
          : <video ref={outroRef as Ref<HTMLVideoElement>} className="fit" style={{ objectPosition: layerPosition(plan, true) }}
              src={convertFileSrc(plan.outro.path)} autoPlay playsInline preload="auto" />}
      </div>}
      {plan.musicPath && <audio ref={musicRef} src={convertFileSrc(plan.musicPath)} autoPlay preload="auto" loop />}
      <canvas ref={captionRef} className="caption-artwork" width={plan.main.format === 'portrait' ? 1080 : 1920}
        height={plan.main.format === 'portrait' ? 1920 : 1080} aria-hidden="true" />
    </div>
  ) : null

  return { path: shown, stage, plan, preparing, clock, playing, player, play: start, stop }
}

function layerPosition(plan: CompositionPlan, outro = false) {
  const layer = outro ? plan.outro : plan.intro
  if (layer?.position) return `${layer.position.x}% ${layer.position.y}%`
  return '50% 50%'
}
