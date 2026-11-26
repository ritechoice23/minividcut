import { useEffect } from 'react'
import { ArrowDownToLine, Check, FolderOpen, LoaderCircle, Monitor, Smartphone, Subtitles, TriangleAlert, X } from 'lucide-react'
import { clipDuration } from './clip'
import { fileSize } from './export-progress'
import type { ExportState } from './export-progress'
import { fileNameExample, QUALITY_OPTIONS } from './preferences'
import type { FileNameParts, Format, Quality } from './preferences'

export type ExportItem = {
  id: number; title: string; number: number; duration: number
  thumbnail?: string; needsCaptions: boolean; state?: ExportState
}
export type ExportSummary = { percent: number; saved: number; total: number; active: number; failed: number; bytes: number; canceled: number }

function itemStatus(item: ExportItem) {
  const state = item.state
  if (!state) return item.needsCaptions
    ? <span className="export-card-status warn"><TriangleAlert size={13} /> No captions on this clip</span>
    : <span className="export-card-status">Ready</span>
  switch (state.status) {
    case 'queued': return <span className="export-card-status">Waiting…</span>
    case 'encoding': {
      const percent = Math.floor(state.fraction * 100)
      return <span className="export-card-status running">Encoding · {percent}%
        <span className="export-card-meter" role="progressbar" aria-label={`${item.title} progress`} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span></span>
    }
    case 'saved': return <span className="export-card-status ok"><Check size={13} /> Saved · {fileSize(state.bytes)} · {state.encoder.startsWith('lib') ? 'CPU' : 'GPU'}</span>
    case 'failed': return <span className="export-card-status error" title={state.error}><TriangleAlert size={13} /> Failed · {state.error}</span>
    case 'canceled': return <span className="export-card-status">Canceled</span>
  }
}

// Export window: pick clips and output once, then watch every clip's progress.
// It never blocks editing; closing it leaves the export running.
export function ExportDialog({
  open, items, checked, aspect, selectedId, format, quality, folder, fileNameParts, running, canceling, summary,
  onClose, onToggle, onCheckAll, onFormat, onQuality, onChangeFolder, onExport, onCancel, onShowFolder, onAddCaptions,
}: {
  open: boolean; items: ExportItem[]; checked: Set<number>; aspect: number; selectedId: number | null
  format: Format; quality: Quality; folder: string; fileNameParts: FileNameParts
  running: boolean; canceling: boolean; summary: ExportSummary | null
  onClose: () => void; onToggle: (id: number) => void; onCheckAll: (ids: number[]) => void
  onFormat: (format: Format) => void; onQuality: (quality: Quality) => void
  onChangeFolder: () => void; onExport: () => void; onCancel: () => void
  onShowFolder: () => void; onAddCaptions: (id: number) => void
}) {
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', close)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.export-dialog .modal-close')?.focus())
    return () => window.removeEventListener('keydown', close)
  }, [open, onClose])
  if (!open) return null
  const chosen = items.filter(item => checked.has(item.id))
  const total = chosen.reduce((sum, item) => sum + item.duration, 0)
  const onlySelected = selectedId !== null && chosen.length === 1 && chosen[0].id === selectedId && items.length > 1
  const heading = running ? canceling ? 'Canceling export' : `Exporting ${summary?.total ?? chosen.length} ${summary?.total === 1 ? 'clip' : 'clips'}`
    : summary ? summary.canceled ? 'Export canceled' : summary.failed ? 'Export finished with errors' : 'Export complete' : null
  return <div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"
      onKeyDown={event => {
        if (event.key !== 'Escape') event.stopPropagation()
      }}>
      <button className="icon-button modal-close" aria-label="Close export" title="Close (keeps exporting)" onClick={onClose}><X size={18} /></button>
      <div className="export-main">
        <h2 id="export-title" className="display-title">Export</h2>
        {heading && summary && <div className={`export-progress${summary.failed ? ' has-errors' : ''}`} role="status">
          <div className="export-progress-line">
            <strong>{heading}</strong>
            <span>{summary.saved} saved{summary.active ? ` · ${summary.active} exporting` : ''}{summary.failed ? ` · ${summary.failed} failed` : ''}{running ? ` · ${summary.total - summary.saved - summary.active - summary.failed} waiting` : summary.bytes ? ` · ${fileSize(summary.bytes)}` : ''}</span>
            <b>{summary.percent}%</b>
            {running ? <button className="button outline small" disabled={canceling} onClick={onCancel}>{canceling ? 'Canceling…' : 'Cancel'}</button>
              : summary.saved > 0 && <button className="button outline small" onClick={onShowFolder}><FolderOpen size={14} /> Show in folder</button>}
          </div>
          <div className="export-progress-bar"><i style={{ width: `${summary.percent}%` }} /></div>
        </div>}
        <ol className="export-grid">{items.map(item => <li key={item.id} className={`export-card${checked.has(item.id) ? '' : ' off'}`}>
          <label className="export-thumb" style={{ aspectRatio: aspect }}>
            {item.thumbnail ? <img alt="" src={item.thumbnail} /> : <span className="export-thumb-empty" />}
            <input type="checkbox" className="check" checked={checked.has(item.id)} disabled={running}
              aria-label={`Export ${item.title}`} onChange={() => onToggle(item.id)} />
          </label>
          <div className="export-card-body">
            <strong title={item.title}>{item.title}</strong>
            <small>{String(item.number).padStart(2, '0')} · {clipDuration(item.duration)} · {format === 'portrait' ? '9:16' : '16:9'}</small>
            {itemStatus(item)}
            {item.state?.status === 'saved' && <button className="link-button" onClick={onShowFolder}>Show in folder</button>}
            {!item.state && item.needsCaptions && item.id > 0 && <button className="link-button" onClick={() => onAddCaptions(item.id)}>
              <Subtitles size={13} /> Add captions first</button>}
          </div>
        </li>)}</ol>
        <p className="export-note">You can close this window and keep editing. Progress stays in the top bar next to Export.</p>
      </div>
      <aside className="export-options">
        <div className="field-label">Clips</div>
        <div className="seg" role="group" aria-label="Clips to export">
          <button aria-pressed={!onlySelected && chosen.length === items.length} disabled={running}
            onClick={() => onCheckAll(items.map(item => item.id))}>All {items.length > 1 ? `${items.length} clips` : 'of it'}</button>
          <button aria-pressed={onlySelected} disabled={running || selectedId === null || items.length < 2 || !items.some(item => item.id === selectedId)}
            onClick={() => selectedId !== null && onCheckAll([selectedId])}>Selected clip</button>
        </div>
        <div className="field-label">Format</div>
        <div className="seg" role="group" aria-label="Output format">
          <button aria-pressed={format === 'portrait'} disabled={running} onClick={() => onFormat('portrait')}><Smartphone size={14} /> Vertical 9:16 · 1080×1920</button>
          <button aria-pressed={format === 'landscape'} disabled={running} onClick={() => onFormat('landscape')}><Monitor size={14} /> 16:9</button>
        </div>
        <div className="field-label">Quality</div>
        <div className="quality-options" role="radiogroup" aria-label="Export quality">{QUALITY_OPTIONS.map(option =>
          <button key={option.value} role="radio" aria-checked={quality === option.value} disabled={running}
            className="choice" onClick={() => onQuality(option.value)}>
            <span><b>{option.title}</b>{option.tag && <em>{option.tag}</em>}</span>
            <small>{option.detail}</small>
          </button>)}</div>
        <div className="field-label">Save to</div>
        <div className="choice folder">
          <span className="mono" title={folder || undefined}>{folder || 'Ask where to save each time'}</span>
          <button className="link-button" disabled={running} onClick={onChangeFolder}>{folder ? 'Change' : 'Choose'}</button>
        </div>
        <div className="export-go">
          <button className="button primary large" disabled={running || !chosen.length} onClick={onExport}>
            {running ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}
            {running ? 'Exporting…' : `Export ${chosen.length} ${chosen.length === 1 ? 'clip' : 'clips'}`}
          </button>
          <small>{clipDuration(total)} of video · files named like “{fileNameExample(fileNameParts)}”</small>
        </div>
      </aside>
    </section>
  </div>
}
