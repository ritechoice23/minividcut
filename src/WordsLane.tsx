import { memo } from 'react'
import { AudioLines, LoaderCircle } from 'lucide-react'
import { stamp } from './clip'
import type { CaptionCue } from './captions'
import { visibleWords } from './timeline'

type Props = {
  /** Every transcribed cue, ordered by start. */
  cues: readonly CaptionCue[]
  viewStart: number
  viewEnd: number
  rangeStart: number
  rangeEnd: number
  /** Dim the words outside the trim range. */
  highlight: boolean
  hasSource: boolean
  disabled: boolean
  /** Progress of listening to the whole video, or null when not listening. */
  listening: number | null
  onSeek: (time: number) => void
  onListen: () => void
}

/**
 * The timeline's Words lane. It is memoized and draws only the cues in view
 * (thinned when there are very many), so unrelated editor state changes no
 * longer rebuild thousands of buttons.
 */
export const WordsLane = memo(function WordsLane({
  cues, viewStart, viewEnd, rangeStart, rangeEnd, highlight, hasSource, disabled, listening, onSeek, onListen,
}: Props) {
  const span = viewEnd - viewStart
  const words = hasSource && span > 0 ? visibleWords(cues, viewStart, viewEnd) : []
  const pct = (value: number) => Math.max(0, Math.min(100, 100 * (value - viewStart) / span))
  return <div className="lane words-lane">
    {words.length ? words.map(cue => <button key={`${cue.start}:${cue.end}`} disabled={disabled}
      className={`word${cue.start < rangeEnd && cue.end > rangeStart && highlight ? ' in-range' : ''}`}
      title={`${stamp(cue.start, true)} · ${cue.text}`}
      style={{ left: `${pct(cue.start)}%`, width: `${Math.max(0.2, pct(cue.end) - pct(cue.start))}%` }}
      onClick={() => onSeek(cue.start)}>{cue.text}</button>)
      : hasSource && (listening !== null
        ? <span className="lane-empty" role="status"><LoaderCircle size={13} className="spin" /> Listening to the video… {Math.round(listening * 100)}%</span>
        : <button className="lane-empty" disabled={disabled} onClick={onListen}><AudioLines size={13} />
          {cues.length ? 'No speech in this part' : 'Show captions here'}</button>)}
  </div>
})
