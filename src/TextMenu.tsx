import { memo, useEffect, useRef } from 'react'
import { Copy, Crosshair, Plus, Trash2, Type, X } from 'lucide-react'
import {
  moveText,
  normalizeText,
  TEXT_FONTS,
  TEXT_MAX_CHARS,
  TEXT_MAX_LAYERS,
  TEXT_MAX_SIZE,
  TEXT_MIN_SIZE,
} from './text-overlay'
import type { TextFont, TextOverlay } from './text-overlay'

export type TextEntry = {
  key: string
  label: string
  time: string
  text: string
  clipId: number | null
  textId: string
  active: boolean
}

export type TextMenuProps = {
  open: boolean
  onClose: () => void
  label: string
  disabled?: boolean
  overlays: TextOverlay[]
  entries: TextEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  onJump: (clipId: number | null, textId: string) => void
  onAdd: () => void
  onChange: (overlay: TextOverlay) => void
  onRemove: (id: string) => void
  onApplyAll: () => void
  canApplyAll: boolean
  format: 'landscape' | 'portrait'
}

const TEXT_COLORS = [
  { name: 'White', value: '#ffffff' },
  { name: 'Lime', value: '#cefa72' },
  { name: 'Yellow', value: '#ffe066' },
  { name: 'Black', value: '#101010' },
] as const

/** Number field with native steppers, used for the values that can also be set
 * by dragging the text on the preview. */
function NumberField({ label, value, min, max, onChange, disabled }: {
  label: string; value: number; min: number; max: number
  onChange: (value: number) => void; disabled?: boolean
}) {
  return <label className="text-number-field">
    <span>{label}</span>
    <span className="text-number">
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={event => {
          if (event.target.value === '') return
          const number = Number(event.target.value)
          if (Number.isFinite(number)) onChange(number)
        }}
      />
      <span aria-hidden="true">%</span>
    </span>
  </label>
}

export const TextMenu = memo(function TextMenu({
  open, onClose, label, disabled = false, overlays, entries, selectedId,
  onSelect, onJump, onAdd, onChange, onRemove, onApplyAll, canApplyAll,
}: TextMenuProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const current = overlays.find(overlay => overlay.id === selectedId) ?? null
  const sizePercent = current ? Math.round(current.size * 100) : 0

  useEffect(() => {
    if (open && selectedId) textarea.current?.focus()
  }, [open, selectedId])

  return (
    <section
      id="text-menu"
      className="moment-panel editor-media-panel panel"
      hidden={!open}
      aria-labelledby="text-menu-title"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
      }}
    >
      <header className="caption-style-heading">
        <h2 id="text-menu-title"><Type size={15} /> Text · {label}</h2>
        <button type="button" className="icon-button compact" aria-label="Close text menu" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="editor-media-fields text-fields">
        {disabled && <small role="status">Save a clip first to add text to that video.</small>}

        <div className="text-section-head"><span>All text blocks</span><small>{entries.length}</small></div>
        <div className="text-layer-list text-all-list" role="group" aria-label="All text blocks">
          {entries.length === 0 && <small className="text-layer-hint">No text has been added yet.</small>}
          {entries.map(entry => (
            <button
              key={entry.key}
              type="button"
              className={`text-layer-item${entry.active ? ' active' : ''}`}
              aria-pressed={entry.active}
              title={`${entry.label} · ${entry.time}`}
              onClick={() => onJump(entry.clipId, entry.textId)}
            >
              <span className="text-layer-label">{entry.text}</span>
              <small className="text-layer-source">{entry.label}</small>
            </button>
          ))}
        </div>

        <div className="text-section-head"><span>On this clip</span><small>{overlays.length}/{TEXT_MAX_LAYERS}</small></div>
        <div className="text-layer-list" role="group" aria-label="Text blocks on this clip">
          {overlays.length === 0 && <small className="text-layer-hint">No text yet — add a text block.</small>}
          {overlays.map((overlay, index) => {
            const preview = overlay.text.trim() ? overlay.text.slice(0, 24) : 'Empty text'
            const selected = selectedId === overlay.id
            return (
              <button
                key={overlay.id}
                type="button"
                className={`text-layer-item${selected ? ' active' : ''}`}
                aria-pressed={selected}
                onClick={() => onSelect(overlay.id)}
              >
                <span className="text-layer-index" aria-hidden="true">{index + 1}</span>
                <span className="text-layer-label">{preview}</span>
              </button>
            )
          })}
        </div>
        <div className="text-layer-actions">
          <button
            type="button"
            className="button outline small"
            disabled={disabled || overlays.length >= TEXT_MAX_LAYERS}
            onClick={onAdd}
          ><Plus size={13} /> Add text</button>
          <button
            type="button"
            className="button outline small"
            disabled={disabled || !current || !canApplyAll}
            title="Copy this text to every saved clip at the same position"
            onClick={onApplyAll}
          ><Copy size={13} /> Apply to all clips</button>
        </div>

        {current ? (
          <>
            <label>
              Overlay text
              <textarea
                ref={textarea}
                rows={2}
                aria-label="Overlay text"
                placeholder="Text to show on the video"
                maxLength={TEXT_MAX_CHARS}
                value={current.text}
                disabled={disabled}
                onChange={event => onChange({ ...current, text: event.target.value })}
              />
            </label>
            <small className="text-char-count">{current.text.length}/{TEXT_MAX_CHARS}</small>

            <div className="text-editor-grid">
              <NumberField label="Size" value={sizePercent} min={Math.round(TEXT_MIN_SIZE * 100)}
                max={Math.round(TEXT_MAX_SIZE * 100)} disabled={disabled}
                onChange={value => onChange(normalizeText({ ...current, size: value / 100 }))} />
              <label>
                Font
                <select
                  aria-label="Text font"
                  value={current.font}
                  disabled={disabled}
                  onChange={event => onChange({ ...current, font: event.target.value as TextFont })}
                >
                  {TEXT_FONTS.map(font => <option key={font} value={font}>{font}</option>)}
                </select>
              </label>
              <div className="text-color-field">
                <span className="text-field-label">Color</span>
                <div className="text-color-swatches" role="group" aria-label="Text color">
                  {TEXT_COLORS.map(color => {
                    const selected = current.color.toLowerCase() === color.value
                    return (
                      <button
                        key={color.value}
                        type="button"
                        className={`text-color-swatch${selected ? ' active' : ''}`}
                        aria-label={`${color.name} text color`}
                        title={color.name}
                        aria-pressed={selected}
                        disabled={disabled}
                        style={{
                          backgroundColor: color.value,
                          outline: selected ? '2px solid var(--lime)' : '1px solid #393939',
                          outlineOffset: 2,
                        }}
                        onClick={() => onChange({ ...current, color: color.value })}
                      />
                    )
                  })}
                </div>
              </div>
              <div className="text-position-field">
                <span className="text-field-label" title="You can also drag the text on the preview">Position</span>
                <div className="text-position-row">
                  <NumberField label="X" value={Math.round(current.x * 100)} min={0} max={100} disabled={disabled}
                    onChange={value => onChange(moveText(current, value / 100, current.y))} />
                  <NumberField label="Y" value={Math.round(current.y * 100)} min={0} max={100} disabled={disabled}
                    onChange={value => onChange(moveText(current, current.x, value / 100))} />
                </div>
              </div>
            </div>

            <div className="text-row-actions">
              <button
                type="button"
                className="button outline small"
                disabled={disabled}
                onClick={() => onChange(moveText(current, 0.5, 0.5))}
              ><Crosshair size={13} /> Center</button>
              <button
                type="button"
                className="button outline small text-remove"
                disabled={disabled}
                onClick={() => onRemove(current.id)}
              ><Trash2 size={13} /> Remove</button>
            </div>
          </>
        ) : (
          <small className="text-layer-hint">Select a text block to edit it.</small>
        )}
      </div>
    </section>
  )
})
