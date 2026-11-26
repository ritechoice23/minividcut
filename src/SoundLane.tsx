import { useEffect, useRef, useState } from 'react'

type Props = {
  /** Loudness per bucket (0–255) across the whole video. */
  peaks: readonly number[]
  duration: number
  /** The slice of the video shown on the timeline right now. */
  view: { start: number; end: number }
  /** Sound inside this range is drawn brighter when `highlight` is on. */
  range: { start: number; end: number }
  highlight: boolean
}

/** The video's own sound as a waveform that follows the timeline's zoom and scroll. */
export function SoundLane({ peaks, duration, view, range, highlight }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const surface = canvas.current
    if (!surface) return
    const observer = new ResizeObserver(() => setTick(value => value + 1))
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
    if (!peaks.length || duration <= 0 || width <= 0) return
    const span = view.end - view.start
    const middle = height / 2
    for (let x = 0; x < width; x += 2) {
      const from = view.start + span * x / width
      const to = view.start + span * (x + 2) / width
      const first = Math.max(0, Math.floor(from / duration * peaks.length))
      const last = Math.min(peaks.length - 1, Math.max(first, Math.ceil(to / duration * peaks.length) - 1))
      let peak = 0
      for (let index = first; index <= last; index++) peak = Math.max(peak, peaks[index] ?? 0)
      const bar = Math.max(1.5, peak / 255 * (height - 4))
      const inside = !highlight || (to > range.start && from < range.end)
      ink.fillStyle = inside ? '#8fa86a' : '#4b5340'
      ink.fillRect(x, middle - bar / 2, 1.5, bar)
    }
  }, [peaks, duration, view.start, view.end, range.start, range.end, highlight, tick])

  return <canvas ref={canvas} className="sound-canvas" aria-hidden="true" />
}
