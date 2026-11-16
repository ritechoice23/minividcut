import type { CaptionTrack } from './captions'
import type { Music } from './music'
import type { Bookends } from './bookends'

export type Range = { start: number; end: number }
// A clip is one editable object that may hold several source ranges. `start`
// and `end` are the outer bounds of `segments` and must always be kept in sync
// through withSegments(). Drafts written before segments existed only have the
// bounds, which clipSegments() reads as a single segment.
export type Clip = Range & {
  id: number
  segments?: Range[]
  title?: string
  titleManuallyEdited?: boolean
  captions?: CaptionTrack
  music?: Music | null
  bookends?: Bookends
}
export const MIN_CLIP = 0.05
export const MAX_CLIPS = 100

export function stamp(seconds: number, precision = false) {
  const ms = Math.round(Math.max(0, seconds) * 1000)
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor(ms / 60_000) % 60
  const whole = Math.floor(ms / 1000) % 60
  const clock = [hours, minutes, whole].map(value => String(value).padStart(2, '0')).join(':')
  return precision ? clock + '.' + String(ms % 1000).padStart(3, '0') : clock
}

export function clipDuration(seconds: number) {
  if (seconds < 1) return '<1s'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const remainder = total % 60
  return [hours && `${hours}h`, minutes && `${minutes}m`, remainder && `${remainder}s`].filter(Boolean).join(' ')
}

export function parseTime(value: string) {
  const time = value.trim()
  if (!/^(?:\d+:){0,2}\d+(?:\.\d{1,3})?$/.test(time)) return NaN
  const parts = time.split(':').map(Number)
  if (parts.some((part, index) => index > 0 && part >= 60)) return NaN
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function validRange(range: Range, duration: number) {
  return Number.isFinite(range.start) && Number.isFinite(range.end)
    && range.start >= 0 && range.end <= duration && range.end - range.start + 0.000001 >= MIN_CLIP
}

const boundary = (value: number, duration: number) => Math.abs(value - duration) <= 0.0005 ? duration : value

export function moveBoundary(range: Range, side: keyof Range, value: number, duration: number): Range | null {
  const mark = boundary(value, duration)
  if (!Number.isFinite(mark) || mark < 0 || mark > duration) return null

  if (side === 'start') {
    return { start: mark, end: Math.min(duration, Math.max(range.end, mark + MIN_CLIP)) }
  }
  return { start: Math.max(0, Math.min(range.start, mark - MIN_CLIP)), end: mark }
}

export function splitRange(range: Range, seconds: number) {
  const count = Math.max(1, Math.ceil((range.end - range.start - MIN_CLIP + 0.000001) / seconds))
  if (count > MAX_CLIPS) return null
  return Array.from({ length: count }, (_, index) => ({
    start: range.start + index * seconds,
    end: index + 1 === count ? range.end : range.start + (index + 1) * seconds,
  }))
}

export function cutRange(source: Range, cut: Range): Range[] {
  if (!rangesOverlap(source, cut)) return [source]
  return [
    { start: source.start, end: Math.min(source.end, cut.start) },
    { start: Math.max(source.start, cut.end), end: source.end },
  ].filter(part => validRange(part, source.end))
}

export function rangesOverlap(first: Range, second: Range) {
  return first.start < second.end && first.end > second.start
}

/**
 * Ripple-delete an In–Out range from an ordered list of kept source ranges.
 * The result stays in source time, but is played and exported back to back,
 * so the deleted material disappears and the remaining footage closes up.
 */
export function deleteFromRanges(kept: readonly Range[], cut: Range): Range[] {
  if (!Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.end <= cut.start) return [...kept]
  return kept.flatMap(range => cutRange(range, cut))
}

export function keptDuration(kept: readonly Range[]) {
  return kept.reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
}

export function clipSegments(clip: Clip): Range[] {
  return clip.segments?.length ? clip.segments : [{ start: clip.start, end: clip.end }]
}

export function withSegments(clip: Clip, segments: readonly Range[], duration: number): Clip | null {
  const sorted = segments
    .filter(segment => validRange(segment, duration))
    .sort((first, second) => first.start - second.start)
    .map(segment => ({ ...segment }))
  if (!sorted.length) return null
  return {
    ...clip,
    segments: sorted,
    start: sorted[0].start,
    end: sorted[sorted.length - 1].end,
  }
}

export function cutSegments(clip: Clip, cut: Range, duration: number): Range[] {
  return clipSegments(clip).flatMap(segment => cutRange(segment, cut)).filter(segment => validRange(segment, duration))
}

// Removes the In–Out range from every saved clip. Each clip stays a single
// object: the remaining source ranges become its segments, so the cut closes
// up on export instead of producing “Part 2” clones.
export function trimClips(
  clips: readonly Clip[],
  cut: Range,
  duration: number,
  sliceCaptions?: (track: CaptionTrack | undefined, range: Range) => CaptionTrack | undefined,
): Clip[] {
  const result: Clip[] = []
  let changed = false
  for (const clip of clips) {
    if (!clipSegments(clip).some(segment => rangesOverlap(segment, cut))) {
      result.push(clip)
      continue
    }
    changed = true
    const remaining = cutSegments(clip, cut, duration)
    if (!remaining.length) continue
    const next = withSegments(clip, remaining, duration)!
    result.push(sliceCaptions
      ? { ...next, captions: sliceCaptions(clip.captions, { start: next.start, end: next.end }) }
      : next)
  }
  return changed ? result : [...clips]
}

export function resizeClipEdge(clip: Clip, side: 'start' | 'end', value: number, duration: number): Clip | null {
  const segments = clipSegments(clip)
  const mark = boundary(value, duration)
  if (!Number.isFinite(mark) || mark < 0 || mark > duration) return null
  if (side === 'start') {
    const first = segments[0]
    if (mark > first.end - MIN_CLIP) return null
    return withSegments(clip, [{ start: mark, end: first.end }, ...segments.slice(1)], duration)
  }
  const last = segments[segments.length - 1]
  if (mark < last.start + MIN_CLIP) return null
  return withSegments(clip, [...segments.slice(0, -1), { start: last.start, end: mark }], duration)
}

export function splitClipAt(clip: Clip, time: number, duration: number): Clip | null {
  const mark = boundary(time, duration)
  const segments = clipSegments(clip)
  const index = segments.findIndex(segment => mark > segment.start + MIN_CLIP && mark < segment.end - MIN_CLIP)
  if (index < 0) return null
  const next = [...segments]
  next.splice(index, 1, { start: segments[index].start, end: mark }, { start: mark, end: segments[index].end })
  return withSegments(clip, next, duration)
}

export function segmentAt(clip: Clip, time: number): Range | null {
  return clipSegments(clip).find(segment => time >= segment.start && time < segment.end) ?? null
}

export type ExportUnit = {
  clip: Clip
  segment: Range
  first: boolean
  last: boolean
}

export function exportUnits(clips: readonly Clip[]): ExportUnit[] {
  return clips.flatMap(clip => {
    const segments = clipSegments(clip)
    return segments.map((segment, index) => ({
      clip, segment, first: index === 0, last: index === segments.length - 1,
    }))
  })
}

export function normalizeClip(clip: Clip, duration: number): Clip | null {
  if (!clip || !Number.isFinite(clip.id)) return null
  if (Array.isArray(clip.segments) && clip.segments.length) return withSegments(clip, clip.segments, duration)
  return validRange(clip, duration) ? { ...clip } : null
}
