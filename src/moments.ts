import type { CaptionCue } from './captions'
import type { Range } from './clip'

export const MOMENT_BATCH_SECONDS = 90
export const DEFAULT_MOMENT_QUERY = 'The most important takeaway or memorable moment'
export type Moment = Range & { text: string; cues: CaptionCue[] }

export function momentLimit(prompt: string, fallback: number) {
  const durations = [...prompt.matchAll(/(?:no more than|not more than|at most|up to|under|less than|max(?:imum)?(?: of)?)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/gi)]
  return Math.min(fallback, ...durations.map(([, amount, unit]) => Number(amount) * (/^m/i.test(unit) ? 60 : 1)))
}

export function momentCandidates(cues: CaptionCue[], range: Range, limit: number): Moment[] {
  const speech = cues.filter(cue => cue.text.trim() && cue.start >= range.start && cue.end <= range.end && cue.end > cue.start)
  // Longer clips tolerate longer pauses so a group can still reach the length
  // the user asked for, while short clips keep breaking at natural pauses.
  const pause = Math.min(Math.max(2.5, limit * 0.25), 10)
  const moments: Moment[] = []
  let index = 0
  while (index < speech.length) {
    const first = speech[index++]
    if (first.end - first.start > limit) continue
    const group = [first]
    let end = first.end
    while (index < speech.length && speech[index].end - first.start <= limit &&
      speech[index].start - end <= pause) {
      const cue = speech[index++]
      group.push(cue)
      end = cue.end
    }
    // A suggestion should use the seconds the user specified, not just the span
    // of its captions. Extend into trailing silence up to the limit, but never
    // cross into the next candidate or past the searchable range.
    const nextStart = index < speech.length ? speech[index].start : range.end
    const fullLength = Math.min(first.start + limit, range.end)
    end = Math.max(end, Math.min(fullLength, nextStart))
    moments.push({ start: first.start, end, text: group.map(cue => cue.text.trim()).join(' '), cues: group })
  }
  return moments
}

export function missingTranscriptRanges(range: Range, coverage: Range[]) {
  const missing: Range[] = []
  let position = range.start
  for (const covered of [...coverage].sort((a, b) => a.start - b.start)) {
    if (covered.end <= position || covered.start >= range.end) continue
    if (covered.start - position >= 1) missing.push({ start: position, end: covered.start })
    position = Math.min(range.end, covered.end)
  }
  if (range.end - position >= 0.05) missing.push({ start: position, end: range.end })
  return missing
}
