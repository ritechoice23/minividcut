import type { Clip, Range } from './clip'

export type CaptionWord = Range & { text: string }
export type CaptionCue = CaptionWord & { words?: CaptionWord[] }
export type CaptionMode = 'phrase' | 'highlight' | 'word'
export type CaptionCase = 'original' | 'lower' | 'upper' | 'title' | 'sentence'
export type CaptionFont = 'Arial' | 'Segoe UI' | 'Georgia' | 'Impact'
export type CaptionPoint = { x: number; y: number }
export type CaptionFormat = 'landscape' | 'portrait'
export type CaptionStyle = {
  preset: 'classic' | 'boxed' | 'serif'
  position: 'top' | 'middle' | 'bottom'
  size: 'small' | 'medium' | 'large'
  mode?: CaptionMode
  case?: CaptionCase
  font?: CaptionFont
  accent?: string
  stroke?: number
  strokeColor?: string
  syncMs?: number
  scale?: number
  points?: Partial<Record<CaptionFormat, CaptionPoint>>
}
export type CaptionTrack = { cues: CaptionCue[]; style: CaptionStyle }
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { preset: 'classic', position: 'bottom', size: 'medium' }
export const CAPTION_FONTS: CaptionFont[] = ['Segoe UI', 'Arial', 'Georgia', 'Impact']
export const CAPTION_ACCENT = '#cefa72'
export const CAPTION_STROKE = '#101010'
export const CAPTION_SYNC_MS = 60

export function captionStroke(style: CaptionStyle) {
  return style.stroke ?? (style.preset === 'boxed' ? 0 : 11)
}

export function clipsNeedingCaptions(clips: readonly Clip[]) {
  return clips.filter(clip => !clip.captions?.cues.some(cue => cue.text.trim()))
}

export function restyleCaptionedClip(clip: Clip, style: CaptionStyle): Clip {
  return clip.captions ? { ...clip, captions: { ...clip.captions, style } } : clip
}

export function captionDisplayText(cues: CaptionCue[], casing: CaptionCase = 'original') {
  let sentenceStart = true
  return cues.map(({ text }) => {
    switch (casing) {
      case 'original': return text
      case 'upper': return text.toUpperCase()
      case 'lower': return text.toLowerCase()
      case 'title': return text.toLowerCase().replace(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu,
        word => word.replace(/\p{L}/u, letter => letter.toUpperCase()))
      case 'sentence': return text.toLowerCase().replace(/[.!?…。！？]|\p{L}/gu, token => {
        if (!/\p{L}/u.test(token)) {
          sentenceStart = true
          return token
        }
        if (!sentenceStart) return token
        sentenceStart = false
        return token.toUpperCase()
      })
    }
  })
}

export function offsetCaption(cue: CaptionCue, offset: number): CaptionCue {
  const shift = <T extends Range>(item: T) => ({ ...item, start: item.start + offset, end: item.end + offset })
  return { ...shift(cue), ...(cue.words ? { words: cue.words.map(shift) } : {}) }
}

export function captionAt<T extends Range>(cues: readonly T[], time: number) {
  let low = 0
  let high = cues.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (cues[middle].start <= time) low = middle + 1
    else high = middle
  }
  const cue = cues[low - 1]
  return cue && time < cue.end ? cue : undefined
}

// Removes a cut range from a caption track. Cues that straddle the cut are
// kept as two shorter cues so the editor no longer shows speech that was
// removed from the clip and will never be exported.
export function captionCut(track: CaptionTrack | undefined, cut: Range): CaptionTrack | undefined {
  if (!track) return undefined
  const cues = track.cues.flatMap(cue => {
    if (cue.end <= cut.start || cue.start >= cut.end) return [cue]
    const parts = [
      { start: cue.start, end: Math.min(cue.end, cut.start) },
      { start: Math.max(cue.start, cut.end), end: cue.end },
    ]
    return parts.flatMap(part => {
      if (part.end - part.start < 0.01) return []
      const words = cue.words?.map(word => ({
        ...word,
        start: Math.min(part.end, Math.max(part.start, word.start)),
        end: Math.min(part.end, Math.max(part.start, word.end)),
      })).filter(word => word.end - word.start > 0.001)
      return [{ ...cue, ...part, ...(words && cue.words ? { words } : {}) }]
    })
  })
  return { ...track, cues }
}

export function captionSlice(track: CaptionTrack | undefined, range: Range, relative = false) {
  if (!track) return undefined
  const offset = relative ? range.start : 0
  const cues = track.cues.flatMap(cue => {
    const start = Math.max(range.start, cue.start)
    const end = Math.min(range.end, cue.end)
    if (end <= start) return []
    const clamp = (time: number) => Math.min(end, Math.max(start, time))
    return [offsetCaption({
      ...cue, start, end,
      ...(cue.words ? { words: cue.words.map(word => ({ ...word, start: clamp(word.start), end: clamp(word.end) })) } : {}),
    }, -offset)]
  })
  return { ...track, cues }
}

export function fitCaptionTiming(cues: CaptionCue[], index: number, edge: keyof Range, value: number, shot: Range) {
  const next = { ...cues[index], [edge]: value }
  const earliest = Math.max(shot.start, cues[index - 1]?.end ?? shot.start)
  const latest = Math.min(shot.end, cues[index + 1]?.start ?? shot.end)
  if (!Number.isFinite(value) || next.start < earliest || next.end > latest || next.end - next.start < 0.01) return null
  const original = cues[index]
  const retime = (time: number) => next.start + (time - original.start) * (next.end - next.start) / (original.end - original.start)
  return original.words ? { ...next, words: original.words.map(word => ({ ...word, start: retime(word.start), end: retime(word.end) })) } : next
}

export function timedWords(cue: CaptionCue) {
  const tokens = cue.text.match(/\S+/gu) ?? []
  const original = cue.words ?? []
  if (original.length === tokens.length) return original.map((word, index) => ({ ...word, text: tokens[index] }))

  // Preserve unchanged words at either end. Retiming a rewritten span is local.
  let prefix = 0
  while (prefix < original.length && prefix < tokens.length && original[prefix].text === tokens[prefix]) prefix++
  let suffix = 0
  while (suffix < Math.min(original.length, tokens.length) - prefix &&
    original[original.length - 1 - suffix].text === tokens[tokens.length - 1 - suffix]) suffix++
  const count = tokens.length - prefix - suffix
  if (!count) return [...original.slice(0, prefix), ...original.slice(original.length - suffix)]
  const changed = original.slice(prefix, original.length - suffix)
  const start = changed[0]?.start ?? original[prefix - 1]?.end ?? cue.start
  const end = Math.max(start, changed.at(-1)?.end ?? original[original.length - suffix]?.start ?? cue.end)
  const step = (end - start) / count
  return [...original.slice(0, prefix), ...tokens.slice(prefix, prefix + count).map((text, index) => ({
    text, start: start + step * index, end: start + step * (index + 1),
  })), ...original.slice(original.length - suffix)]
}

export type CaptionState = Range & { cue: CaptionCue; active: number; mode: CaptionMode }

export function captionStates(cue: CaptionCue, mode: CaptionMode, syncMs = 0): CaptionState[] {
  if (!cue.text.trim()) return []
  if (mode === 'phrase') return [{ start: cue.start, end: cue.end, cue, active: -1, mode }]
  const states: CaptionState[] = []
  let cursor = cue.start
  const delay = syncMs / 1000
  timedWords(cue).forEach((word, active, words) => {
    if (word.end <= word.start) return
    const start = Math.max(cursor, word.start + delay)
    const next = words[active + 1]
    // Shift connected word boundaries together. Leave a real pause clear.
    const end = Math.min(cue.end, word.end + (next && Math.abs(next.start - word.end) < 0.08 ? delay : 0))
    if (end <= start) return
    if (mode === 'highlight' && start - cursor > 0.000001) states.push({ start: cursor, end: start, cue, active: -1, mode })
    states.push({ start, end, cue, active, mode })
    cursor = end
  })
  if (mode === 'highlight' && cursor < cue.end) states.push({ start: cursor, end: cue.end, cue, active: -1, mode })
  return states
}
