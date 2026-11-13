export const MAX_TIMELINE_ZOOM = 128

export function timelineWindow(duration: number, zoom: number, start: number) {
  const span = duration / zoom
  const maxStart = duration - span
  const left = Math.max(0, Math.min(maxStart, start))
  return { start: left, end: left + span, span, maxStart }
}

export function zoomTimeline(duration: number, zoom: number, playhead: number) {
  return timelineWindow(duration, zoom, playhead - duration / zoom / 2).start
}

export function timelineTime(start: number, span: number, fraction: number) {
  return start + span * Math.max(0, Math.min(1, fraction))
}

export function panTimeline(duration: number, zoom: number, start: number, screenFraction: number) {
  return timelineWindow(duration, zoom, start + screenFraction * duration / zoom).start
}
