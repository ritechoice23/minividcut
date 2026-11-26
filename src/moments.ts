import type { CaptionCue } from './captions'
import type { Range } from './clip'

export const MOMENT_BATCH_SECONDS = 90
export const DEFAULT_MOMENT_QUERY = 'The most important takeaway or memorable moment'
export type Moment = Range & { text: string; cues: CaptionCue[] }

/**
 * One-click searches. Each request is short and concrete because the
 * on-device model matches plain descriptions far better than long prompts.
 */
export const MOMENT_PRESETS: readonly { id: string; label: string; request: string }[] = [
  { id: 'takeaways', label: 'Key takeaways', request: DEFAULT_MOMENT_QUERY },
  { id: 'trending', label: 'Trending hooks', request: 'a bold, surprising statement that grabs attention fast' },
  { id: 'motivational', label: 'Motivational', request: 'motivational moments that push the listener to take action' },
  { id: 'inspiring', label: 'Inspiring', request: 'inspiring words about hope, purpose or never giving up' },
  { id: 'funny', label: 'Funny', request: 'the funniest moment, a joke or a witty line' },
  { id: 'story', label: 'Stories', request: 'a personal story with a clear lesson or turning point' },
  { id: 'tips', label: 'Tips & how-to', request: 'practical tips or step by step advice' },
  { id: 'facts', label: 'Surprising facts', request: 'surprising facts or numbers people would share' },
  { id: 'emotional', label: 'Emotional', request: 'an emotional, heartfelt moment' },
  { id: 'quotes', label: 'Quotable lines', request: 'a short quotable line that works on its own' },
]

export function momentLimit(prompt: string, fallback: number) {
  const durations = [...prompt.matchAll(/(?:no more than|not more than|at most|up to|under|less than|max(?:imum)?(?: of)?)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/gi)]
  return Math.min(fallback, ...durations.map(([, amount, unit]) => Number(amount) * (/^m/i.test(unit) ? 60 : 1)))
}

/**
 * Turns what the user typed into the plain description the model handles
 * best: length limits (already applied by momentLimit) and request filler
 * like "find me 5 clips of" are removed, leaving just the topic.
 */
export function momentRequest(prompt: string) {
  const topic = prompt
    .replace(/,?\s*(?:no more than|not more than|at most|up to|under|less than|max(?:imum)?(?: of)?)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m)\b/gi, '')
    .replace(/^\s*(?:please\s+)?(?:find|show|give|get|pull|extract|cut|make)(?:\s+me)?\s+/i, '')
    .replace(/^(?:the\s+)?(?:\d+|a few|some|all(?: the)?)\s+/i, '')
    .replace(/^(?:short\s+)?(?:clips?|moments?|parts?|bits?|sections?|highlights?)\s+(?:of|about|with|where|that|on)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return topic || DEFAULT_MOMENT_QUERY
}

// Lines that make a poor short no matter what the user asked for.
const BOILERPLATE = /\b(?:subscribe|hit the bell|notification bell|link in the (?:description|bio)|welcome back|thanks for watching|see you (?:next time|in the next)|this video is sponsored|our sponsor|let me know in the comments|smash (?:that|the) like)\b/i
const SENTENCE_END = /[.!?…]["'”’)]?$/

/** Whether a candidate carries enough substance to be worth asking the model about. */
export function momentWorthy(text: string) {
  return text.split(/\s+/).filter(Boolean).length >= 6 && !BOILERPLATE.test(text)
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
    // When the length limit cuts a thought off mid-sentence, end on the last
    // complete sentence instead (if that keeps at least half the length) and
    // let the next candidate start cleanly at the following sentence.
    const cutShort = index < speech.length && speech[index].start - end <= pause
    if (cutShort && !SENTENCE_END.test(group[group.length - 1].text.trim())) {
      let last = group.length - 2
      while (last >= 0 && !SENTENCE_END.test(group[last].text.trim())) last--
      if (last >= 0 && group[last].end - first.start >= limit * 0.5) {
        index -= group.length - 1 - last
        group.length = last + 1
        end = group[last].end
      }
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
