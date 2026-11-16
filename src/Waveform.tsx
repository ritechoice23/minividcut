import { useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

type Props = {
  path: string
  duration: number
  position: number
  inPoint: number
  onInPoint: (seconds: number) => void
}

const BAR_COUNT = 96

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
export function Waveform({ path, duration, position, inPoint, onInPoint }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const [peaks, setPeaks] = useState<number[]>([])

  useEffect(() => {
    let active = true
    setPeaks([])
    const context = new AudioContext()
    void fetch(convertFileSrc(path)).then(response => response.arrayBuffer())
      .then(buffer => context.decodeAudioData(buffer))
      .then(audio => {
        if (active) setPeaks(peaksFrom(audio))
      })
      .catch(() => {})
      .finally(() => void context.close())
    return () => { active = false }
  }, [path])

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
    if (duration > 0) {
      const inX = Math.min(width, inPoint / duration * width)
      ink.fillStyle = '#cefa72'
      ink.fillRect(0, 0, inX, height)
      ink.fillRect(inX - 1, 0, 2, height)
      const playX = Math.min(width, position / duration * width)
      ink.fillStyle = '#f2f2f0'
      ink.fillRect(playX - 0.5, 0, 1, height)
    }
  }, [peaks, duration, position, inPoint])

  const seekToPointer = (clientX: number) => {
    const surface = canvas.current
    if (!surface || duration <= 0) return
    const rect = surface.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onInPoint(Math.min(duration - 0.05, fraction * duration))
  }

  return <canvas ref={canvas} className="kaino-waveform" aria-label="Preview waveform, drag to set the music start point"
    role="slider" aria-valuemin={0} aria-valuemax={Math.max(0, duration)} aria-valuenow={inPoint}
    tabIndex={0} onPointerDown={event => {
      dragging.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      seekToPointer(event.clientX)
    }} onPointerMove={event => { if (dragging.current) seekToPointer(event.clientX) }}
    onPointerUp={() => { dragging.current = false }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft') onInPoint(Math.max(0, inPoint - 0.5))
      else if (event.key === 'ArrowRight') onInPoint(Math.min(Math.max(0, duration - 0.05), inPoint + 0.5))
      else return
      event.preventDefault()
    }} />
}
