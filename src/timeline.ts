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

export function timelineOverlaps(ranges: { start: number; end: number }[]) {
  const edges = ranges.flatMap(range => [{ time: range.start, delta: 1 }, { time: range.end, delta: -1 }])
    .sort((a, b) => a.time - b.time)
  const overlaps: { start: number; end: number }[] = []
  let count = 0
  for (let index = 0; index < edges.length;) {
    const start = edges[index].time
    while (edges[index]?.time === start) count += edges[index++].delta
    if (count < 2 || index === edges.length) continue
    const end = edges[index].time
    const previous = overlaps.at(-1)
    if (previous?.end === start) previous.end = end
    else overlaps.push({ start, end })
  }
  return overlaps
}

export function timelineFrames(duration: number, zoom: number, start: number) {
  if (duration <= 0) return []
  const span = duration / zoom
  const step = span / 10
  return Array.from({ length: 11 }, (_, index) => Math.floor(start / step) + index)
    .filter(index => index < zoom * 10 && index * step < start + span)
    .map(index => ({
      index, time: (index + 0.35) * step,
      left: 100 * (index * step - start) / span,
    }))
}
