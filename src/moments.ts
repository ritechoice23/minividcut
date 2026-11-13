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
  const moments: Moment[] = []
  let index = 0
  while (index < speech.length) {
    const first = speech[index++]
    if (first.end - first.start > limit) continue
    const group = [first]
    let end = first.end
    while (index < speech.length && speech[index].end - first.start <= limit &&
      speech[index].start - end <= 2.5) {
      const cue = speech[index++]
      group.push(cue)
      end = cue.end
    }
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
