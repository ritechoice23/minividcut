import { memo, useEffect, useRef } from 'react'
import { Crosshair, Plus, Trash2, Type, X } from 'lucide-react'
import {
  moveText,
  TEXT_FONTS,
  TEXT_MAX_CHARS,
  TEXT_MAX_LAYERS,
  TEXT_MAX_SIZE,
  TEXT_MIN_SIZE,
} from './text-overlay'
import type { TextFont, TextOverlay } from './text-overlay'

export type TextMenuProps = {
  open: boolean
  onClose: () => void
  label: string
  disabled?: boolean
  overlays: TextOverlay[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onChange: (overlay: TextOverlay) => void
  onRemove: (id: string) => void
  format: 'landscape' | 'portrait'
}

const TEXT_COLORS = [
  { name: 'White', value: '#ffffff' },
  { name: 'Lime', value: '#cefa72' },
  { name: 'Yellow', value: '#ffe066' },
  { name: 'Black', value: '#101010' },
] as const

export const TextMenu = memo(function TextMenu({
  open, onClose, label, disabled = false,
  overlays, selectedId, onSelect, onAdd, onChange, onRemove,
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
      <div className="editor-media-fields">
        {disabled && <small role="status">Save a clip first to add text to that video.</small>}
        <div className="text-layer-list" role="group" aria-label="Text blocks">
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
          <small className="text-layer-count">{overlays.length}/{TEXT_MAX_LAYERS}</small>
        </div>
        {current ? (
          <>
            <label>
              Overlay text
              <textarea
                ref={textarea}
                rows={3}
                aria-label="Overlay text"
                placeholder="Text to show on the video"
                maxLength={TEXT_MAX_CHARS}
                value={current.text}
                disabled={disabled}
                onChange={event => onChange({ ...current, text: event.target.value })}
              />
            </label>
            <small className="text-char-count">{current.text.length}/{TEXT_MAX_CHARS}</small>
            <label>
              <span className="text-slider-label">Text size <output>{sizePercent}%</output></span>
              <input
                aria-label="Text size"
                type="range"
                min={TEXT_MIN_SIZE * 100}
                max={TEXT_MAX_SIZE * 100}
                step={1}
                value={sizePercent}
                disabled={disabled}
                onChange={event => onChange({ ...current, size: Number(event.target.value) / 100 })}
              />
            </label>
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
            <label>
              <span className="text-slider-label">Horizontal <output>{Math.round(current.x * 100)}%</output></span>
              <input
                aria-label="Horizontal position"
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(current.x * 100)}
                disabled={disabled}
                onChange={event => onChange(moveText(current, Number(event.target.value) / 100, current.y))}
              />
            </label>
            <label>
              <span className="text-slider-label">Vertical <output>{Math.round(current.y * 100)}%</output></span>
              <input
                aria-label="Vertical position"
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(current.y * 100)}
                disabled={disabled}
                onChange={event => onChange(moveText(current, current.x, Number(event.target.value) / 100))}
              />
            </label>
            <button
              type="button"
              className="button outline small"
              disabled={disabled}
              onClick={() => onChange(moveText(current, 0.5, 0.5))}
            ><Crosshair size={13} /> Center</button>
            <small>Tip: drag the text on the preview to position it.</small>
            <button
              type="button"
              className="button outline small text-remove"
              disabled={disabled}
              onClick={() => onRemove(current.id)}
            ><Trash2 size={13} /> Remove text</button>
          </>
        ) : (
          <small className="text-layer-hint">Select a text block to edit it.</small>
        )}
      </div>
    </section>
  )
})
