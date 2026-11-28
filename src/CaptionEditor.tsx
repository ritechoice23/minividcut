import { memo, useId, useState } from 'react'
import { Clock3, Copy, Plus, Subtitles, Trash2, X } from 'lucide-react'
import { parseTime, stamp } from './clip'
import type { Range } from './clip'
import { CAPTION_ACCENT, CAPTION_FONTS, CAPTION_STROKE, DEFAULT_CAPTION_STYLE, captionStroke, fitCaptionTiming } from './captions'
import type { CaptionFormat, CaptionStyle, CaptionTrack } from './captions'

export type CaptionModel = { installed: boolean; bytes: number }
export type CaptionProgress = ({ stage: 'preparing' | 'loading' | 'starting' | 'canceling' }
  | { stage: 'downloading' | 'transcribing'; fraction: number }) & { index?: number; total?: number }

export function progressLabel(progress: CaptionProgress) {
  switch (progress.stage) {
    case 'starting':
    case 'preparing': return 'Preparing audio…'
    case 'loading': return 'Loading the caption model…'
    case 'canceling': return 'Canceling…'
    case 'downloading': return 'Downloading the speech model…'
    case 'transcribing': return 'Listening to the clip…'
  }
}

function CueTime({ label, value, offset, onSave }: {
  label: string; value: number; offset: number; onSave: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const clock = stamp(value - offset, true).replace(/^00:/, '')
  return <input aria-label={label} title={label} spellCheck={false}
    value={draft ?? clock}
    onChange={event => setDraft(event.target.value)}
    onBlur={() => {
      if (draft !== null) onSave(parseTime(draft) + offset)
      setDraft(null)
    }}
    onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur()
      if (event.key === 'Escape') setDraft(null)
    }}
  />
}

function StyleNumber({ label, unit, value, min, max, presets, onChange }: {
  label: string; unit: string; value: number; min: number; max: number
  presets: number[]; onChange: (value: number) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  return <label>{label}
    <span className="caption-number">
      <input type="number" list={id} min={min} max={max} step="1" value={draft ?? value}
        aria-label={`${label} (${unit})`}
        onChange={event => {
          const input = event.currentTarget
          setDraft(input.value)
          if (input.value && input.validity.valid) onChange(input.valueAsNumber)
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <span aria-hidden="true">{unit}</span>
    </span>
    <datalist id={id}>{presets.map(preset => <option key={preset} value={preset} />)}</datalist>
  </label>
}

const STYLE_OPTIONS = {
  preset: { classic: 'Outline only', boxed: 'Soft box', serif: 'Serif' },
  mode: { phrase: 'Phrase', highlight: 'Highlight', word: 'Word by word' },
  case: { original: 'Original', lower: 'lowercase', upper: 'UPPERCASE', title: 'Title Case', sentence: 'Sentence case' },
}

export const CaptionEditor = memo(function CaptionEditor({
  label, range, track, model, progress, status, editing, canGenerate, defaultStyle,
  onChange, onGenerate, onCancel, onSeek, getTime,
}: {
  label: string; range: Range; track?: CaptionTrack; model: CaptionModel | null; progress: CaptionProgress | null
  status: string; editing: boolean; onChange: (track: CaptionTrack) => void
  canGenerate: boolean; defaultStyle?: CaptionStyle
  onGenerate: () => void; onCancel: () => void
  onSeek: (time: number) => void; getTime: () => number
}) {
  const [feedback, setFeedback] = useState('')
  const [openCue, setOpenCue] = useState<number | null>(null)
  const { style, cues } = track ?? { style: defaultStyle ?? DEFAULT_CAPTION_STYLE, cues: [] }
  const update = (next: CaptionTrack) => { setFeedback(''); onChange(next) }
  const setTime = (index: number, edge: keyof Range, value: number) => {
    const cue = fitCaptionTiming(cues, index, edge, value, range)
    if (cue) update({ style, cues: cues.map((item, row) => row === index ? cue : item) })
    else setFeedback('Enter a time within the shot and between neighboring captions.')
  }
  const add = () => {
    const start = Math.max(range.start, Math.round(getTime() * 1000) / 1000)
    const next = cues.findIndex(cue => cue.start >= start)
    const index = next < 0 ? cues.length : next
    const end = Math.min(range.end, start + 2, cues[index]?.start ?? range.end)
    if (start >= range.end || end - start < 0.01 || (cues[index - 1]?.end ?? 0) > start) {
      setFeedback('Move the playhead to a gap in the shot to add a caption.')
      return
    }
    update({ style, cues: [...cues.slice(0, index), { start, end, text: '' }, ...cues.slice(index)] })
  }

  return <section className="caption-editor" id="caption-editor" aria-label="Caption editor">
    <div className="caption-heading">
      <div><p title={label}>{label}</p></div>
    </div>
    {progress ? <CaptionJobProgress progress={progress} onCancel={onCancel} /> : <>
    <div className="caption-actions">
        <button className="button outline small" disabled={!model || !canGenerate} onClick={onGenerate}>
          {model?.installed ? cues.length ? 'Regenerate' : 'Generate captions'
            : model ? `Download & generate · ${Math.round(model.bytes / 1_000_000)} MB` : 'Generate captions'}
        </button>
        <div className="caption-tools">
        <button className="icon-button compact" title="Add caption at playhead" aria-label="Add caption at playhead" onClick={add}><Plus size={16} /></button>
        </div>
    </div>
    {(feedback || status) && <p className="caption-feedback" role="status">{feedback || status}</p>}
    {model && !model.installed && !progress && !status && <p className="caption-feedback">One-time download. Transcription runs on this device.</p>}
    {cues.length > 0 && <>
      <ol className="caption-cues">
        {cues.map((cue, index) => <li key={index}>
          <fieldset disabled={editing} aria-label={`Caption ${index + 1}`}>
          <div className="caption-cue-row">
          <textarea aria-label={`Caption ${index + 1} text`} rows={2} maxLength={180} value={cue.text}
            onFocus={() => onSeek(cue.start)}
            onChange={event => update({ style, cues: cues.map((item, row) => row === index ? { ...item, text: event.target.value } : item) })} />
          <div className="caption-cue-tools">
          <button type="button" className="icon-button compact" title="Caption timing and actions"
            aria-label={`Timing and actions for caption ${index + 1}`} aria-expanded={openCue === index}
            onClick={() => setOpenCue(current => current === index ? null : index)}><Clock3 size={12} /></button>
            <button type="button" className="icon-button compact" title="Remove caption" aria-label={`Remove caption ${index + 1}`}
              onClick={() => {
                setOpenCue(current => current === null || current === index ? null : current > index ? current - 1 : current)
                update({ style, cues: cues.filter((_, row) => row !== index) })
              }}><Trash2 size={13} /></button>
          </div>
          </div>
          {openCue === index && <div className="caption-cue-time">
            <CueTime label={`Caption ${index + 1} start`} value={cue.start} offset={range.start} onSave={value => setTime(index, 'start', value)} />
            <span aria-hidden="true">–</span>
            <CueTime label={`Caption ${index + 1} end`} value={cue.end} offset={range.start} onSave={value => setTime(index, 'end', value)} />

          </div>}
          </fieldset>
        </li>)}
      </ol>
    </>}
    </>}
  </section>
})

export function CaptionStylePanel({ style, format, editing, canApplyStyle, onStyle, onApplyStyle, onClose, embedded = false }: {
  style: CaptionStyle; format: CaptionFormat; editing: boolean; canApplyStyle: boolean
  onStyle: (style: CaptionStyle) => void; onApplyStyle: (style: CaptionStyle) => boolean; onClose: () => void
  /** Rendered inside the Style tab of the Captions panel, without its own frame. */
  embedded?: boolean
}) {
  const restyle = (changes: Partial<CaptionStyle>) => onStyle({ ...style, ...changes })
  const applyStyle = () => { if (onApplyStyle(style)) onClose() }
  return <section id="caption-style-panel" className={embedded ? 'caption-style-panel embedded' : 'moment-panel caption-style-panel panel'} aria-labelledby="caption-style-title"
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }}>
        <header className="caption-style-heading" hidden={embedded}>
          <h2 id="caption-style-title" tabIndex={-1}>Caption style</h2>
          <button className="icon-button compact" aria-label="Close caption style" onClick={() => onClose()}><X size={17} /></button>
        </header>
        <fieldset className="caption-style" disabled={editing} aria-label="Caption appearance">
        <label>Show words<select aria-label="How words appear" value={style.mode ?? 'phrase'}
          onChange={event => restyle({ mode: event.target.value as CaptionStyle['mode'] })}>
          {Object.entries(STYLE_OPTIONS.mode).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        </select></label>
        <label>Font<select aria-label="Font" value={style.font ?? (style.preset === 'serif' ? 'Georgia' : 'Arial')}
          onChange={event => restyle({ font: event.target.value as CaptionStyle['font'] })}>
          {CAPTION_FONTS.map(font => <option key={font}>{font}</option>)}
        </select></label>
        <label>Background<select aria-label="Caption background" value={style.preset} onChange={event => {
          const preset = event.target.value as CaptionStyle['preset']
          restyle({ preset, font: preset === 'serif' ? 'Georgia' : style.font })
        }}>
          {Object.entries(STYLE_OPTIONS.preset).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        </select></label>
        <label>Letter case<select aria-label="Capitalization" value={style.case ?? 'original'}
          onChange={event => restyle({ case: event.target.value as CaptionStyle['case'] })}>
          {Object.entries(STYLE_OPTIONS.case).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        </select></label>
        {!embedded && <label>Position<select aria-label="Position" value={style.points?.[format] ? 'custom' : style.position}
          onChange={event => restyle({ position: event.target.value as CaptionStyle['position'], points: { ...style.points, [format]: undefined } })}>
          {style.points?.[format] && <option value="custom" disabled>Custom</option>}
          <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
        </select></label>}
        {!embedded && <StyleNumber label="Text size" unit="%" min={55} max={200}
          value={Math.round((style.scale ?? (style.size === 'small' ? 0.81 : style.size === 'large' ? 1.25 : 1)) * 100)}
          presets={[75, 90, 100, 110, 125, 150, 175, 200]} onChange={scale => restyle({ scale: scale / 100 })} />}
        <StyleNumber label="Outline width" unit="%" min={0} max={30}
          value={captionStroke(style)} presets={[0, 2, 4, 6, 8, 11, 15, 20, 25, 30]} onChange={stroke => restyle({ stroke })} />
        {style.mode === 'highlight' && <label>Highlight color<input type="color" aria-label="Highlight color"
          value={style.accent ?? CAPTION_ACCENT} onChange={event => restyle({ accent: event.target.value })} /></label>}
        <label>Outline color<input type="color" aria-label="Outline color" value={style.strokeColor ?? CAPTION_STROKE}
          onChange={event => restyle({ strokeColor: event.target.value })} /></label>
        </fieldset>
        <footer className="caption-style-footer" hidden={embedded}>
          <button className="button outline small" disabled={!canApplyStyle} onClick={applyStyle}><Copy size={14} /> Apply to all clips</button>
          <button className="button primary small" onClick={() => onClose()}>Done</button>
        </footer>
      </section>
}

export function CaptionJobProgress({ progress, onCancel }: { progress: CaptionProgress; onCancel: () => void }) {
  const fraction = 'fraction' in progress ? progress.fraction : undefined
  const percent = fraction === undefined ? undefined : Math.floor(100 * fraction)
  return <div className="caption-job">
    <div className="caption-job-ring" role="progressbar" aria-label={progressLabel(progress)} aria-valuenow={percent}>
      <svg viewBox="0 0 64 64" className={percent === undefined ? 'spin' : undefined} aria-hidden="true">
        <circle cx="32" cy="32" r="28" />
        <circle cx="32" cy="32" r="28" pathLength="100" strokeDasharray={`${percent ?? 24} 100`} />
      </svg>
      {percent === undefined ? <Subtitles size={21} aria-hidden="true" /> : <strong>{percent}%</strong>}
    </div>
    <div role="status" className="caption-job-label">
      <strong>{progressLabel(progress)}</strong>
      {(progress.total ?? 0) > 1 && <span>Clip {(progress.index ?? 0) + 1} of {progress.total}</span>}
    </div>
    <button className="text-button" onClick={onCancel} disabled={progress.stage === 'canceling'}>Cancel</button>
  </div>
}
