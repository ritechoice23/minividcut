import { memo } from 'react'
import type { CSSProperties } from 'react'
import {
  ArrowDownToLine, Check, Clapperboard, Copy, Ellipsis, Film, GripVertical, Music2, Pencil, Play, Sparkles, Subtitles, Trash2, Type, X,
} from 'lucide-react'
import { clipDuration, stamp } from './clip'
import type { Clip } from './clip'
import { ClipActions } from './ClipActions'
import { fileSize } from './export-progress'
import type { ExportState } from './export-progress'

const CLIP_COLORS = ['#78bfff', '#d4a0ff', '#f5bb70', '#7fe0b6', '#ff9db4', '#a6c9ff', '#e8d982', '#9bdfec', '#efad87', '#c3e887', '#e7a4e9', '#a5a8ff']
export const clipColor = (id: number) => CLIP_COLORS[Math.max(0, id - 1) % CLIP_COLORS.length]

function ExportBadge({ state }: { state: ExportState }) {
  const device = state.status === 'saved'
    ? (state.encoder.startsWith('lib') ? 'CPU' : 'GPU')
    : undefined
  const label = state.status === 'saved' ? `${fileSize(state.bytes)} · ${device}`
    : state.status === 'encoding' ? `${Math.floor(state.fraction * 100)}%`
    : state.status === 'failed' ? 'Failed' : state.status === 'canceled' ? 'Canceled' : 'Queued'
  const title = state.status === 'failed' ? state.error
    : state.status === 'saved' ? `Encoded on ${device} (${state.encoder})` : undefined
  return <span className={`export-badge ${state.status}`} title={title}>
    {state.status === 'saved' && <Check size={12} />} {label}
  </span>
}

/**
 * What a row can ask the editor to do. The editor hands every row the same
 * object for its whole life (it forwards to the latest handlers), so a row only
 * re-renders when its own clip or flags change.
 */
export type ClipRowActions = {
  select: (clip: Clip, clicks: number) => void
  doubleClick: (clip: Clip, locked: boolean) => void
  startRename: (id: number) => void
  cancelRename: () => void
  rename: (id: number, title: string) => void
  reorder: (from: number, to: number) => void
  dragStart: (index: number) => void
  isDragging: () => boolean
  drop: (index: number) => void
  dragEnd: () => void
  toggleMenu: (id: number) => void
  closeMenu: () => void
  preview: (clip: Clip) => void
  retitle: (clip: Clip) => void
  captions: (clip: Clip) => void
  update: (clip: Clip) => void
  duplicate: (clip: Clip) => void
  exportOnly: (clip: Clip) => void
  remove: (clip: Clip) => void
}

export type ClipRowProps = {
  clip: Clip
  /** Zero-based place in the list shown on screen. */
  position: number
  /** Index among the saved clips, or -1 for the temporary single-export row. */
  savedIndex: number
  title: string
  selected: boolean
  locked: boolean
  editing: boolean
  disabled: boolean
  busy: boolean
  reorderable: boolean
  aspect: number
  fit: 'cover' | 'contain'
  objectPosition: string
  thumbnail: string | undefined
  hasMusic: boolean
  hasText: boolean
  hasBookends: boolean
  needsCaptions: boolean
  state: ExportState | undefined
  menuOpen: boolean
  canUpdate: boolean
  canDuplicate: boolean
  canRemove: boolean
  actions: ClipRowActions
}

export const ClipRow = memo(function ClipRow({
  clip, position, savedIndex, title, selected, locked, editing, disabled, busy, reorderable, aspect, fit, objectPosition,
  thumbnail, hasMusic, hasText, hasBookends, needsCaptions, state, menuOpen, canUpdate, canDuplicate, canRemove, actions,
}: ClipRowProps) {
  const captioned = !needsCaptions
  return <li data-clip-id={clip.id} className={selected ? 'selected' : ''}
    draggable={savedIndex >= 0 && !busy && !editing && reorderable}
    onDragStart={event => { actions.dragStart(savedIndex); event.dataTransfer.effectAllowed = 'move' }}
    onDragOver={event => { if (actions.isDragging()) event.preventDefault() }}
    onDrop={event => {
      event.preventDefault()
      actions.drop(savedIndex)
    }}
    onDragEnd={actions.dragEnd}>
    {reorderable && savedIndex >= 0 && <span className="grip" aria-hidden="true" title="Drag to reorder"><GripVertical size={15} /></span>}
    <span className="clip-number">{String(position + 1).padStart(2, '0')}</span>
    {editing ? <form className="clip-rename" aria-label="Edit clip title" onSubmit={event => {
      event.preventDefault()
      const value = String(new FormData(event.currentTarget).get('title') ?? '')
      actions.rename(clip.id, value === title && !clip.title ? '' : value)
    }} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        actions.cancelRename()
      }
    }}>
      <input autoFocus name="title" aria-label={`Rename ${title}`} maxLength={80} defaultValue={title}
        onFocus={event => event.currentTarget.select()} />
      <button type="submit" className="icon-button compact save-title" title="Save title" aria-label="Save title"><Check size={15} /></button>
      <button type="button" className="icon-button compact" title="Cancel rename" aria-label="Cancel rename" onClick={actions.cancelRename}><X size={14} /></button>
    </form> : <button className="clip-select" aria-pressed={selected} disabled={disabled}
      title={locked ? `${title} · Preview only during export` : `${title} · Double-click to rename · Alt ↑/↓ to reorder`}
      onClick={event => actions.select(clip, event.detail)}
      onDoubleClick={() => actions.doubleClick(clip, locked)}
      onKeyDown={event => {
        if (event.key === 'F2' && !locked) {
          event.preventDefault()
          actions.startRename(clip.id)
        } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && savedIndex >= 0) {
          event.preventDefault()
          actions.reorder(savedIndex, savedIndex + (event.key === 'ArrowUp' ? -1 : 1))
        }
      }}>
      <span className="clip-thumbnail" style={{ aspectRatio: aspect }}>
        {thumbnail
          ? <img alt="" src={thumbnail} style={{ objectFit: fit, objectPosition }} />
          : <Film size={15} />}
      </span>
      <span className="clip-details">
        <strong>{title}</strong>
        <small><span className="duration-chip" style={{ '--clip-color': clipColor(clip.id) } as CSSProperties}>{clipDuration(clip.end - clip.start)}</span> {stamp(clip.start)} – {stamp(clip.end)}</small>
        <span className="clip-flags">
          <span className={`clip-flag${captioned ? ' on' : ' warn'}`} title={captioned ? 'Has captions' : 'No captions yet'}><Subtitles size={12} /></span>
          <span className={`clip-flag${hasMusic ? ' on' : ''}`} title={hasMusic ? 'Has music' : 'No music'}><Music2 size={12} /></span>
          <span className={`clip-flag${hasText ? ' on' : ''}`} title={hasText ? 'Has text on picture' : 'No text'}><Type size={12} /></span>
          <span className={`clip-flag${hasBookends ? ' on' : ''}`} title={hasBookends ? 'Has intro or outro' : 'No intro or outro'}><Clapperboard size={12} /></span>
        </span>
      </span>
    </button>}
    {state && <ExportBadge state={state} />}
    {!locked && !editing && <button className="icon-button compact clip-more" aria-label={`Actions for ${title}`} title="Clip actions"
      aria-expanded={menuOpen} aria-controls={menuOpen ? `clip-actions-${clip.id}` : undefined}
      disabled={disabled} onClick={() => actions.toggleMenu(clip.id)}><Ellipsis size={17} /></button>}
    {!locked && !editing && menuOpen && <ClipActions id={`clip-actions-${clip.id}`} label={`Actions for ${title}`} onClose={actions.closeMenu}>
      <button onClick={() => { actions.closeMenu(); actions.preview(clip) }}><Play size={14} /> Preview finished clip</button>
      <button onClick={() => { actions.closeMenu(); actions.startRename(clip.id) }}><Pencil size={14} /> Rename</button>
      <button onClick={() => { actions.closeMenu(); actions.retitle(clip) }}>
        <Sparkles size={15} /> {clip.title ? 'Retitle with AI' : 'Title with AI'}
      </button>
      <button onClick={() => { actions.closeMenu(); actions.captions(clip) }}>
        <Subtitles size={15} /> {needsCaptions ? 'Generate captions' : 'Edit captions'}
      </button>
      <button disabled={!canUpdate} onClick={() => { actions.closeMenu(); actions.update(clip) }}>
        <Check size={14} /> Update from timeline range</button>
      <button disabled={!canDuplicate} onClick={() => actions.duplicate(clip)}><Copy size={14} /> Duplicate</button>
      <button disabled={busy} onClick={() => { actions.closeMenu(); actions.exportOnly(clip) }}><ArrowDownToLine size={14} /> Export only this clip</button>
      <button className="danger" disabled={!canRemove} onClick={() => actions.remove(clip)}><Trash2 size={14} /> Remove clip</button>
    </ClipActions>}
    {state?.status === 'encoding' && <div className="clip-meter" aria-hidden="true"><span style={{ width: `${state.fraction * 100}%` }} /></div>}
  </li>
})
