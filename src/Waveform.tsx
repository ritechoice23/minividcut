import { useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

type Props = {
  path: string
  duration: number
  position: number
  inPoint: number
  onInPoint: (seconds: number) => void
  className?: string
  readOnly?: boolean
}

const BAR_COUNT = 96
const PEAK_CACHE_LIMIT = 60

// Decoded peaks are immutable for a given file path, so share them across
// mounts and preview switches instead of decoding the same file repeatedly.
const peakCache = new Map<string, number[]>()
let audioContext: AudioContext | null = null

function sharedAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

function cachePeaks(path: string, values: number[]) {
  peakCache.set(path, values)
  if (peakCache.size > PEAK_CACHE_LIMIT) {
    const oldest = peakCache.keys().next().value
    if (oldest !== undefined) peakCache.delete(oldest)
  }
}

function peaksFrom(audio: AudioBuffer): number[] {
  const data = audio.getChannelData(0)
  const peaks: number[] = []
  const stride = Math.max(1, Math.floor(data.length / BAR_COUNT))
  for (let bar = 0; bar < BAR_COUNT; bar++) {
    const from = bar * stride
    const to = Math.min(data.length, from + stride)
    let peak = 0
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]))
    peaks.push(peak)
  }
  const loudest = Math.max(0.05, ...peaks)
  return peaks.map(value => Math.max(0.08, value / loudest))
}

/** A compact audition strip: waveform, playhead and a draggable in-point. */
export function Waveform({ path, duration, position, inPoint, onInPoint, className = 'kaino-waveform', readOnly = false }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const [peaks, setPeaks] = useState<number[]>([])
  const [resizeTick, setResizeTick] = useState(0)

  useEffect(() => {
    let active = true
    const cached = peakCache.get(path)
    if (cached) {
      setPeaks(cached)
      return () => { active = false }
    }
    setPeaks([])
    void fetch(convertFileSrc(path)).then(response => response.arrayBuffer())
      .then(buffer => sharedAudioContext().decodeAudioData(buffer))
      .then(audio => {
        const values = peaksFrom(audio)
        cachePeaks(path, values)
        if (active) setPeaks(values)
      })
      .catch(() => {})
    return () => { active = false }
  }, [path])

  useEffect(() => {
    const surface = canvas.current
    if (!surface) return
    const observer = new ResizeObserver(() => setResizeTick(tick => tick + 1))
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const surface = canvas.current
    const ink = surface?.getContext('2d')
    if (!surface || !ink) return
    const width = surface.clientWidth
    const height = surface.clientHeight
    const ratio = window.devicePixelRatio || 1
    if (surface.width !== Math.round(width * ratio) || surface.height !== Math.round(height * ratio)) {
      surface.width = Math.round(width * ratio)
      surface.height = Math.round(height * ratio)
    }
    ink.setTransform(ratio, 0, 0, ratio, 0, 0)
    ink.clearRect(0, 0, width, height)
    const middle = height / 2
    const barWidth = width / Math.max(1, peaks.length)
    ink.fillStyle = peaks.length ? '#5f6b4c' : '#353535'
    peaks.forEach((peak, index) => {
      const bar = Math.max(2, peak * (height - 4))
      ink.fillRect(index * barWidth + 0.5, middle - bar / 2, Math.max(1, barWidth - 1), bar)
    })
    if (duration > 0 && !readOnly) {
      const inX = Math.min(width, inPoint / duration * width)
      ink.fillStyle = '#cefa72'
      ink.fillRect(0, 0, inX, height)
      ink.fillRect(inX - 1, 0, 2, height)
      const playX = Math.min(width, position / duration * width)
      ink.fillStyle = '#f2f2f0'
      ink.fillRect(playX - 0.5, 0, 1, height)
    }
  }, [peaks, duration, position, inPoint, resizeTick, readOnly])

  const seekToPointer = (clientX: number) => {
    const surface = canvas.current
    if (!surface || duration <= 0) return
    const rect = surface.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onInPoint(Math.min(duration - 0.05, fraction * duration))
  }

  return <canvas ref={canvas} className={className}
    aria-label={readOnly ? undefined : 'Preview waveform, drag to set the music start point'}
    aria-hidden={readOnly ? true : undefined}
    role={readOnly ? undefined : 'slider'}
    aria-valuemin={readOnly ? undefined : 0}
    aria-valuemax={readOnly ? undefined : Math.max(0, duration)}
    aria-valuenow={readOnly ? undefined : inPoint}
    tabIndex={readOnly ? undefined : 0}
    onPointerDown={readOnly ? undefined : event => {
      dragging.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      seekToPointer(event.clientX)
    }} onPointerMove={readOnly ? undefined : event => { if (dragging.current) seekToPointer(event.clientX) }}
    onPointerUp={readOnly ? undefined : () => { dragging.current = false }}
    onKeyDown={readOnly ? undefined : event => {
      if (event.key === 'ArrowLeft') onInPoint(Math.max(0, inPoint - 0.5))
      else if (event.key === 'ArrowRight') onInPoint(Math.min(Math.max(0, duration - 0.05), inPoint + 0.5))
      else return
      event.preventDefault()
    }} />
}
