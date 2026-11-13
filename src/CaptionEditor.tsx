import { memo, useState } from 'react'
import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { parseTime, stamp } from './clip'
import type { Range } from './clip'
import { CAPTION_ACCENT, CAPTION_FONTS, DEFAULT_CAPTION_STYLE, fitCaptionTiming } from './captions'
import type { CaptionFormat, CaptionStyle, CaptionTrack } from './captions'

export type CaptionModel = { installed: boolean; bytes: number }
export type CaptionProgress = { stage: 'preparing' | 'loading' | 'starting' | 'canceling' }
  | { stage: 'downloading' | 'transcribing'; fraction: number }

function progressLabel(progress: CaptionProgress) {
  switch (progress.stage) {
    case 'starting':
    case 'preparing': return 'Preparing audio…'
    case 'loading': return 'Loading the caption model…'
    case 'canceling': return 'Canceling…'
    case 'downloading': return `Downloading model · ${Math.floor(progress.fraction * 100)}%`
    case 'transcribing': return `Transcribing · ${Math.floor(progress.fraction * 100)}%`
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

const STYLE_OPTIONS = {
  preset: { classic: 'Classic', boxed: 'Soft box', serif: 'Editorial serif' },
  mode: { phrase: 'Phrase', highlight: 'Highlight', word: 'Word by word' },
  case: { original: 'Original', lower: 'lowercase', upper: 'UPPERCASE', title: 'Title Case', sentence: 'Sentence case' },
}

export const CaptionEditor = memo(function CaptionEditor({
  label, range, track, model, progress, status, format, editing, canApplyStyle, defaultStyle,
  onChange, onStyle, onApplyStyle, onGenerate, onCancel, onSeek, getTime,
}: {
  label: string; range: Range; track?: CaptionTrack; model: CaptionModel | null; progress: CaptionProgress | null
  status: string; format: CaptionFormat; editing: boolean; onChange: (track: CaptionTrack) => void
  canApplyStyle: boolean; defaultStyle?: CaptionStyle; onApplyStyle: (style: CaptionStyle) => boolean
  onStyle: (style: CaptionStyle) => void; onGenerate: () => void; onCancel: () => void
  onSeek: (time: number) => void; getTime: () => number
}) {
  const [feedback, setFeedback] = useState('')
  const [styleOpen, setStyleOpen] = useState(false)
  const { style, cues } = track ?? { style: defaultStyle ?? DEFAULT_CAPTION_STYLE, cues: [] }
  const update = (next: CaptionTrack) => { setFeedback(''); onChange(next) }
  const restyle = (changes: Partial<CaptionStyle>) => { setFeedback(''); onStyle({ ...style, ...changes }) }
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
    <div className="caption-actions">
      {progress ? <>
        <span role="status"><LoaderCircle size={13} className="spin" /> {progressLabel(progress)}</span>
        <button className="text-button" onClick={onCancel} disabled={progress.stage === 'starting' || progress.stage === 'canceling'}>Cancel</button>
      </> : <>
        <button className="button outline small" disabled={!model} onClick={onGenerate}>
          {model?.installed ? cues.length ? 'Regenerate' : 'Generate captions'
            : model ? `Download & generate · ${Math.round(model.bytes / 1_000_000)} MB` : 'Generate captions'}
        </button>
        <button className="icon-button compact" title="Add caption at playhead" aria-label="Add caption at playhead" onClick={add}><Plus size={16} /></button>
      </>}
    </div>
    {(feedback || status) && <p className="caption-feedback" role="status">{feedback || status}</p>}
    {model && !model.installed && !progress && !status && <p className="caption-feedback">One-time download. Transcription runs on this device.</p>}
    {cues.length > 0 && <>
      <div className="caption-style-bar">
        <button className="text-button" aria-expanded={styleOpen} aria-controls="caption-style" onClick={() => setStyleOpen(open => !open)}>Style</button>
        <label><span className="sr-only">Caption behavior</span>
          <select aria-label="Caption behavior" value={style.mode ?? 'phrase'} disabled={editing}
            onChange={event => restyle({ mode: event.target.value as CaptionStyle['mode'] })}>
            {Object.entries(STYLE_OPTIONS.mode).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
          </select>
        </label>
      </div>
      {styleOpen && <fieldset id="caption-style" className="caption-style" disabled={editing} aria-label="Caption appearance">
        <label>Font<select aria-label="Font" value={style.font ?? (style.preset === 'serif' ? 'Georgia' : 'Arial')}
          onChange={event => restyle({ font: event.target.value as CaptionStyle['font'] })}>
          {CAPTION_FONTS.map(font => <option key={font}>{font}</option>)}
        </select></label>
        <label>Finish<select aria-label="Finish" value={style.preset} onChange={event => {
          const preset = event.target.value as CaptionStyle['preset']
          restyle({ preset, font: preset === 'serif' ? 'Georgia' : style.font })
        }}>
          {Object.entries(STYLE_OPTIONS.preset).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        </select></label>
        <label>Case<select aria-label="Capitalization" value={style.case ?? 'original'}
          onChange={event => restyle({ case: event.target.value as CaptionStyle['case'] })}>
          {Object.entries(STYLE_OPTIONS.case).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        </select></label>
        <label>Position<select aria-label="Position" value={style.points?.[format] ? 'custom' : style.position}
          onChange={event => restyle({ position: event.target.value as CaptionStyle['position'], points: { ...style.points, [format]: undefined } })}>
          {style.points?.[format] && <option value="custom" disabled>Custom</option>}
          <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
        </select></label>
        <label>Size<input type="range" aria-label="Caption size" min="0.55" max="2" step="0.01"
          value={style.scale ?? (style.size === 'small' ? 0.81 : style.size === 'large' ? 1.25 : 1)}
          onChange={event => restyle({ scale: Number(event.target.value) })} /></label>
        {style.mode === 'highlight' && <label>Highlight<input type="color" aria-label="Highlight color"
          value={style.accent ?? CAPTION_ACCENT} onChange={event => restyle({ accent: event.target.value })} /></label>}
        <button className="text-button caption-apply" disabled={!canApplyStyle}
          title="Copy this style to all clips and use it for new captions"
          onClick={() => {
            if (onApplyStyle(style)) {
              setStyleOpen(false)
              setFeedback('Style applied to all clips.')
            }
          }}>Apply to all clips</button>
      </fieldset>}
      <ol className="caption-cues">
        {cues.map((cue, index) => <li key={index}>
          <fieldset disabled={editing} aria-label={`Caption ${index + 1}`}>
          <div className="caption-cue-time">
            <button className="text-button" onClick={() => onSeek(cue.start)}
              aria-label={`Seek to caption ${index + 1}`} title="Seek to caption">{index + 1}</button>
            <CueTime label={`Caption ${index + 1} start`} value={cue.start} offset={range.start} onSave={value => setTime(index, 'start', value)} />
            <span aria-hidden="true">–</span>
            <CueTime label={`Caption ${index + 1} end`} value={cue.end} offset={range.start} onSave={value => setTime(index, 'end', value)} />
            <button className="icon-button compact" title="Remove caption" aria-label={`Remove caption ${index + 1}`}
              onClick={() => update({ style, cues: cues.filter((_, row) => row !== index) })}><Trash2 size={13} /></button>
          </div>
          <textarea aria-label={`Caption ${index + 1} text`} rows={2} maxLength={180} value={cue.text}
            onFocus={() => onSeek(cue.start)}
            onChange={event => update({ style, cues: cues.map((item, row) => row === index ? { ...item, text: event.target.value } : item) })} />
          </fieldset>
        </li>)}
      </ol>
    </>}
  </section>
})
