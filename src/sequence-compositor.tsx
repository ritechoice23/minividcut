import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { useEditor } from './editor-store'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { Range } from './clip'
import type { Bookends } from './bookends'
import type { CaptionTrack } from './captions'
import { captionAt } from './captions'
import { captionDimensions, captionLayouts, captionSequence, renderCaptionSprite } from './caption-artwork'
import type { FramePosition, Framing } from './framing'
import type { Music } from './music'
import { musicGain } from './music'
import { buildCompositionPlan, layerState, outroLayerState, sourceToPlanTime } from './sequence-plan'
import type { BookendMedia, CompositionPlan, Format, LayerState } from './sequence-plan'

export type Sequence = {
  path: string
  range: Range
  segments?: Range[]
  captions?: CaptionTrack
  music: Music | null
  musicPath: string
  muted: boolean
  bookends: Bookends
  options: { format: Format; framing: Framing; position: FramePosition }
  /** Source-timeline position to start from, e.g. where the user clicked. */
  startAtSource?: number
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
  seekSource: (time: number) => void
  setMuted: (muted: boolean) => void
}

type BookendInfo = { image: boolean; path: string; name: string; duration?: number }

export function useSequenceCompositor(key: string, onError: (message: string) => void) {
  const [shown, setShown] = useState<string | null>(null)
  const [plan, setPlan] = useState<CompositionPlan | null>(null)
  const planRef = useRef<CompositionPlan | null>(null)
  const [preparing, setPreparing] = useState(false)

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
  const grantedAssets = useRef(new Set<string>())
  const forceMute = useRef(false)

  // Media elements output audio directly. Routing them through a Web Audio
  // AudioContext made every layer silent whenever that context stayed
  // suspended under the webview's autoplay policy, even though the picture
  // was playing. Volume and mute are applied on the elements themselves.
  const safePlay = (element: HTMLMediaElement) => {
    if (player.current.paused || !element.paused) return
    void element.play().catch(() => {
      // WebView2 can reject unmuted autoplay even after a click. Retry muted
      // and keep subsequent frames muted until the preview is restarted.
      forceMute.current = true
      element.muted = true
      void element.play().catch(() => {})
    })
  }

  const player = useRef<SequenceController>({
    currentTime: 0, duration: 0, paused: true, readyState: 4, volume: 1, muted: false,
    play: async () => {}, pause: () => {}, seek: () => {}, seekSource: () => {}, setMuted: () => {},
  })

  const applyLayer = (element: HTMLMediaElement | null, state: LayerState, local: number,
    flag: 'intro' | 'main' | 'outro', image: boolean) => {
    if (!element) return
    element.hidden = !state.active
    if (!state.active) {
      // Always stop inactive layers. With autoPlay removed they would otherwise
      // keep advancing (and playing audio) in the background, leaving the
      // intro/outro elements stale or ended when their window finally opens.
      if (!image) element.pause()
      visible.current[flag] = false
      return
    }
    element.style.opacity = String(state.alpha)
    element.style.transform = state.slide ? `translateX(${state.slide}%)` : ''
    if (image) return
    if (!visible.current[flag] || Math.abs(element.currentTime - local) > 0.25) element.currentTime = local
    element.volume = state.alpha * player.current.volume
    element.muted = player.current.muted || forceMute.current
    if (player.current.paused) element.pause()
    else if (!visible.current[flag] || element.paused) safePlay(element)
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
      const offset = Math.max(0, current.music.start ?? 0)
      const local = audio.duration > 0 ? (time + offset) % audio.duration : time + offset
      const gain = musicGain(time, 0, current.total, current.music.fade)
      audio.volume = current.music.volume / 100 * player.current.volume * gain
      audio.muted = player.current.muted || forceMute.current
      if (!visible.current.music || Math.abs(audio.currentTime - local) > 0.4) audio.currentTime = local
      if (player.current.paused) audio.pause()
      else safePlay(audio)
      visible.current.music = true
    }
    painter.current?.(main.local, main.active)
  }, [])

  const pause = useCallback(() => {
    player.current.paused = true
    useEditor.getState().setSequencePlaying(false)
    window.cancelAnimationFrame(raf.current)
    // Image bookends are <img> elements with no pause() method.
    for (const element of [mainRef.current, introRef.current, outroRef.current, musicRef.current]) {
      if (element instanceof HTMLMediaElement) element.pause()
    }
  }, [])

  const seek = useCallback((time: number) => {
    const current = planRef.current
    if (!current) return
    const value = Math.max(0, Math.min(current.total, time))
    player.current.currentTime = value
    update(current, value)
    useEditor.getState().setSequenceTime(value, current.total, mainTime(current, value))
  }, [update])

  const seekSource = useCallback((time: number) => {
    const current = planRef.current
    if (!current) return
    seek(sourceToPlanTime(current, time))
  }, [seek])

  const play = useCallback(async () => {
    // Read the plan from the ref, not from the render closure: this callback
    // is memoized with stable dependencies, so a captured `plan` would stay
    // null forever and playback would silently do nothing.
    const current = planRef.current
    if (!current) return
    const restarting = player.current.currentTime <= 0.001 || player.current.currentTime >= current.total - 0.001
    if (restarting) {
      player.current.currentTime = 0
      // Start every layer from the beginning of the composition. Without this,
      // a previously ended intro/outro or a stale clock position makes the
      // first pass skip part of the bookends.
      visible.current = { intro: false, main: false, outro: false, music: false }
      for (const element of [mainRef.current, introRef.current, outroRef.current, musicRef.current]) {
        if (element instanceof HTMLMediaElement) {
          element.pause()
          element.currentTime = 0
        }
      }
      update(current, 0)
    }
    player.current.paused = false
    useEditor.getState().setSequencePlaying(true)
    lastFrame.current = performance.now()
    window.cancelAnimationFrame(raf.current)

    // The audio element that is actually making sound is the most stable
    // clock in the browser. When it is playing, advance from its currentTime
    // and use requestVideoFrameCallback of the visible video as a secondary
    // sync. Fall back to the rAF wall clock only before playback starts.
    const tick = (now: number) => {
      if (player.current.paused || !planRef.current) return
      const current = planRef.current
      const wall = player.current.currentTime + Math.min(0.25, (now - lastFrame.current) / 1000)
      lastFrame.current = now

      let time = wall
      // Music loops modulo its own duration and has no meaningful mapping to
      // the composition timeline, so it must never be used as the clock.
      const clockMedia = current.intro && layerState(current.intro, current, wall).active && !current.intro.image
        ? introRef.current
        : current.outro && outroLayerState(current, wall).active && !current.outro.image
          ? outroRef.current
          : mainRef.current
      if (clockMedia && !clockMedia.paused && clockMedia.readyState > 1 &&
          Number.isFinite(clockMedia.duration) && clockMedia.duration > 0) {
        const clockTime = current.intro && clockMedia === introRef.current
          ? clockMedia.currentTime
          : current.outro && clockMedia === outroRef.current
            ? current.outro.start + clockMedia.currentTime
            : current.main.start + (clockMedia.currentTime - current.main.sourceStart)
        if (Number.isFinite(clockTime) && Math.abs(clockTime - wall) < 0.6) time = clockTime
      }

      if (time >= current.total) {
        time = current.total
        player.current.pause()
      }
      player.current.currentTime = time
      update(current, time)
      if (now - lastClock.current > 100) {
        lastClock.current = now
        useEditor.getState().setSequenceTime(time, current.total, mainTime(current, time))
      }
      if (!player.current.paused) raf.current = window.requestAnimationFrame(tick)
    }
    raf.current = window.requestAnimationFrame(tick)
  }, [update, seek])

  // Keep the frame loop tied to the compositor's actual rendered frames when
  // the browser supports it, instead of only running on the rAF wall clock.
  useEffect(() => {
    const video = mainRef.current
    if (!shown || !video?.requestVideoFrameCallback) return
    let handle = 0
    let active = true
    const onFrame = () => {
      if (!active || player.current.paused || !planRef.current) return
      update(planRef.current, player.current.currentTime)
      handle = video.requestVideoFrameCallback(onFrame)
    }
    handle = video.requestVideoFrameCallback(onFrame)
    return () => { active = false; video.cancelVideoFrameCallback?.(handle) }
  }, [shown, update])

  // An explicit unmute from the transport has to clear the autoplay fallback,
  // otherwise applyLayer re-applies forceMute on the next frame and the button
  // appears to do nothing.
  const setMuted = useCallback((muted: boolean) => {
    player.current.muted = muted
    if (!muted) forceMute.current = false
  }, [])

  player.current.play = play
  player.current.pause = pause
  player.current.seek = seek
  player.current.seekSource = seekSource
  player.current.setMuted = setMuted

  const stop = useCallback(() => {
    ++request.current
    pause()
    window.cancelAnimationFrame(raf.current)
    for (const path of grantedAssets.current) void invoke('release_asset', { path }).catch(() => {})
    grantedAssets.current.clear()
    planRef.current = null
    player.current.currentTime = 0
    player.current.duration = 0
    visible.current = { intro: false, main: false, outro: false, music: false }
    forceMute.current = false
    painter.current = null
    setShown(null)
    setPlan(null)
    setPreparing(false)
    useEditor.getState().setSequencePlaying(false)
    useEditor.getState().setSequenceActive(false)
    useEditor.getState().setSequenceTime(0, 0, 0)
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
    let cancelled = false
    let attempts = 0
    const prime = () => {
      if (cancelled) return
      const elements = [mainRef.current, introRef.current, outroRef.current]
        .filter((element): element is HTMLMediaElement => element instanceof HTMLMediaElement)
      const ready = elements.every(element => element.readyState >= 2) || attempts++ > 30
      if (!ready) {
        window.setTimeout(prime, 50)
        return
      }
      void player.current.play()
    }
    prime()
    return () => { cancelled = true }
  }, [shown])

  const resolveMedia = async (end: NonNullable<Bookends['intro']>): Promise<BookendMedia> => {
    const cached = mediaCache.current.get(end.path)
    if (cached) return cached
    if (end.image) {
      const preview = await invoke<string>('bookend_thumbnail', { path: end.path }).catch(() => '')
      const media = { image: true, duration: end.duration ?? 2, preview }
      mediaCache.current.set(end.path, media)
      return media
    }
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
      for (const path of entries.map(([path]) => path)) {
        await invoke('allow_asset', { path })
        grantedAssets.current.add(path)
      }
      if (request.current !== job) return
      const media = Object.fromEntries(entries)
      // Caption cues stay in absolute source time; layerState('main').local is
      // also source time, so the painter can follow jumps across segments.
      const captions = sequence.captions
      let musicPath = sequence.musicPath
      if (sequence.music && !musicPath) {
        musicPath = await invoke<string>('open_music', { track: sequence.music.track })
      }
      if (musicPath) grantedAssets.current.add(musicPath)
      const next = buildCompositionPlan({
        path: sequence.path, range: sequence.range, segments: sequence.segments, bookends: sequence.bookends, media,
        format: sequence.options.format, framing: sequence.options.framing,
        position: sequence.options.position, captions, music: sequence.music,
        musicPath, muted: sequence.muted,
      })
      preparePainter(captions, sequence.options.format)
      planRef.current = next
      const startAt = sequence.startAtSource == null ? 0 : sourceToPlanTime(next, sequence.startAtSource)
      player.current.currentTime = startAt
      player.current.duration = next.total
      player.current.muted = next.muted
      useEditor.getState().setSequenceTime(startAt, next.total, mainTime(next, startAt))
      useEditor.getState().setSequenceActive(true)
      setPlan(next)
      // Adopt the new key here so a late cache/music revision change cannot
      // tear down a preview that just started.
      keyRef.current = sequenceKey
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
    <div className="composite" aria-label="Full clip preview" onClick={() => { forceMute.current = false; player.current.pause() }}>
      {plan.intro && <div className="composite-layer">
        {plan.intro.image
          ? <img ref={introRef as Ref<HTMLImageElement>} className="fit" style={{ objectPosition: layerPosition(plan) }}
              src={plan.intro.preview || convertFileSrc(plan.intro.path)} alt="" draggable={false} />
          : <video ref={introRef as Ref<HTMLVideoElement>} className="fit" style={{ objectPosition: layerPosition(plan) }}
              src={convertFileSrc(plan.intro.path)} playsInline preload="auto" />}
      </div>}
      <div className="composite-layer">
        <video ref={mainRef} className={plan.main.framing} style={{ objectPosition: `${plan.main.position.x}% ${plan.main.position.y}%` }}
          src={convertFileSrc(plan.main.path)} playsInline preload="auto" />
      </div>
      {plan.outro && <div className="composite-layer">
        {plan.outro.image
          ? <img ref={outroRef as Ref<HTMLImageElement>} className="fit" style={{ objectPosition: layerPosition(plan, true) }}
              src={plan.outro.preview || convertFileSrc(plan.outro.path)} alt="" draggable={false} />
          : <video ref={outroRef as Ref<HTMLVideoElement>} className="fit" style={{ objectPosition: layerPosition(plan, true) }}
              src={convertFileSrc(plan.outro.path)} playsInline preload="auto" />}
      </div>}
      {plan.musicPath && <audio ref={musicRef} src={convertFileSrc(plan.musicPath)} preload="auto" loop />}
      <canvas ref={captionRef} className="caption-artwork" width={plan.main.format === 'portrait' ? 1080 : 1920}
        height={plan.main.format === 'portrait' ? 1920 : 1080} aria-hidden="true" />
    </div>
  ) : null

  return { path: shown, stage, preparing, player, play: start, stop }
}

function mainTime(plan: CompositionPlan, time: number) {
  const state = layerState('main', plan, time)
  if (state.active) return state.local
  return time < plan.main.start ? plan.main.sourceStart : plan.main.sourceStart + plan.main.length
}

function layerPosition(plan: CompositionPlan, outro = false) {
  const layer = outro ? plan.outro : plan.intro
  if (layer?.position) return `${layer.position.x}% ${layer.position.y}%`
  return '50% 50%'
}
