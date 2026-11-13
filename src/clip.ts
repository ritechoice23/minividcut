export type Range = { start: number; end: number }
export type Clip = Range & { id: number }
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

export function moveBoundary(range: Range, side: keyof Range, value: number, duration: number): Range | null {
  const mark = Math.abs(value - duration) <= 0.0005 ? duration : value
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
