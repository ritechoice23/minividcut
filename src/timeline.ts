export const MAX_TIMELINE_ZOOM = 128
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128]

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

// Keeps the time under the cursor at the same screen position after zooming.
export function zoomAround(duration: number, zoom: number, anchor: number, fraction: number) {
  const span = duration / zoom
  return Math.max(0, Math.min(duration - span, anchor - fraction * span))
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

export function snapTime(value: number, candidates: readonly number[], threshold: number) {
  let nearest = value
  let distance = threshold
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate)) continue
    const gap = Math.abs(candidate - value)
    if (gap <= distance) {
      nearest = candidate
      distance = gap
    }
  }
  return nearest
}

/** Most word buttons the timeline draws at once; more would be unreadable anyway. */
export const MAX_VISIBLE_WORDS = 240

/**
 * The cues, ordered by start, that touch the visible window, thinned to at most
 * about `limit` evenly spread entries. A long talk has tens of thousands of
 * cues, and drawing a button for each at full zoom-out froze the editor; once
 * the user zooms in far enough every cue is shown.
 */
export function visibleWords<T extends { start: number; end: number }>(
  cues: readonly T[], viewStart: number, viewEnd: number, limit = MAX_VISIBLE_WORDS,
): T[] {
  let low = 0
  let high = cues.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (cues[middle].start < viewStart) low = middle + 1
    else high = middle
  }
  // A cue that began before the window can still reach into it.
  let first = low
  while (first > 0 && cues[first - 1].end > viewStart) first--
  const inView: T[] = []
  for (let index = first; index < cues.length && cues[index].start < viewEnd; index++) {
    if (cues[index].end > viewStart) inView.push(cues[index])
  }
  if (inView.length <= limit) return inView
  const slot = (viewEnd - viewStart) / limit
  const thinned: T[] = []
  let lastSlot = Number.NEGATIVE_INFINITY
  for (const cue of inView) {
    const current = Math.floor((cue.start - viewStart) / slot)
    if (current === lastSlot) continue
    lastSlot = current
    thinned.push(cue)
  }
  return thinned
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
