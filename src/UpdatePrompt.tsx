import { useEffect, useState } from 'react'
import { ArrowDownToLine, Check, RefreshCw, X } from 'lucide-react'
import { formatBytes, updateIndicatorLabel } from './updates'
import { progressLabel, type AppUpdate } from './useAppUpdate'

const DIALOG_PHASES = ['available', 'ready', 'error'] as const

/** Persistent top-bar hint: download progress, and the restart prompt once the
 * update is ready. Clicking the download pill reveals or hides the detail toast. */
export function UpdateIndicator({ update }: { update: AppUpdate }) {
  const { status } = update
  const label = updateIndicatorLabel(status)
  if (!label) return null
  const percent = status.phase === 'downloading' ? status.percent : null
  const detail = status.phase === 'downloading' && status.total
    ? `${formatBytes(status.downloaded)} / ${formatBytes(status.total)}`
    : ''
  const title = detail ? `${label} · ${detail}` : label

  if (status.phase === 'downloading') return <button type="button" className="update-indicator downloading"
    title={`${title} · click to ${update.progressHidden ? 'show' : 'hide'} details`}
    onClick={update.progressHidden ? update.showProgress : update.hideProgress}>
      <span className="update-indicator-bar" style={{ width: `${percent ?? 0}%` }} aria-hidden="true" />
      <ArrowDownToLine size={13} /> {label}
    </button>
  if (status.phase === 'ready') return <button type="button" className="update-indicator ready"
    title="Update downloaded — restart to install it" onClick={() => void update.install()}>
      <Check size={13} /> {label}
    </button>
  if (status.phase === 'error') return <button type="button" className="update-indicator error"
    title={status.detail} onClick={() => void update.retry()}><RefreshCw size={12} /> {label}</button>
  return <span className="update-indicator" title={title}>{label}</span>
}

/** One-time dialog, then background progress so the editor stays usable. */
export function UpdatePrompt({ update }: { update: AppUpdate }) {
  const { status } = update
  const info = 'info' in status ? status.info : null
  const [dialogOpen, setDialogOpen] = useState(true)
  const notice = status.phase === 'error' ? `error:${status.message}` : `${status.phase}:${info?.version ?? ''}`

  useEffect(() => {
    setDialogOpen(true)
  }, [notice])

  useEffect(() => {
    if (!dialogOpen || !DIALOG_PHASES.includes(status.phase as typeof DIALOG_PHASES[number])) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDialogOpen(false) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialogOpen, status.phase])

  if (status.phase === 'idle' || status.phase === 'checking' || status.phase === 'current') return null

  const showDialog = dialogOpen && (DIALOG_PHASES as readonly string[]).includes(status.phase)
  const version = info?.version ?? ''

  return <>
    {status.phase === 'downloading' && !update.progressHidden && <div className="update-toast" role="status">
      <span className="update-toast-icon"><ArrowDownToLine size={15} /></span>
      <div className="update-toast-text">
        <strong>{progressLabel(status)}</strong>
        <progress max={100} value={status.percent ?? undefined} aria-label="Update download progress" />
        <small>Keep working — the top bar shows progress and will ask you to restart.</small>
      </div>
      <button className="icon-button compact" aria-label="Hide download progress" title="Hide details — download continues"
        onClick={update.hideProgress}><X size={14} /></button>
    </div>}

    {showDialog && <div className="update-dialog-backdrop">
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title"
        aria-describedby="update-dialog-text">
        <div className="update-dialog-top">
          <span className={`update-dialog-icon ${status.phase}`}>
            {status.phase === 'ready' ? <Check size={20} /> : status.phase === 'error' ? <RefreshCw size={20} /> : <ArrowDownToLine size={20} />}
          </span>
          <button className="icon-button compact" aria-label="Close update dialog" title="Close"
            onClick={() => setDialogOpen(false)}><X size={16} /></button>
        </div>

        <div className="update-dialog-body">
          <span className="update-dialog-eyebrow">
            {status.phase === 'ready' ? 'Ready when you are' : status.phase === 'error' ? 'Something went wrong' : 'New version available'}
          </span>
          <h2 id="update-dialog-title">
            {status.phase === 'ready' ? 'Update ready to install'
              : status.phase === 'error' ? 'Update failed'
                : `MiniVidCut v${version} is available`}
          </h2>
          <p id="update-dialog-text">
            {status.phase === 'ready'
              ? `Version ${version} is downloaded. Restart now to install it, or carry on editing and restart from the top bar later.`
              : status.phase === 'error'
                ? status.message
                : 'Download it in the background and keep editing. Progress stays in the top bar, and we’ll ask before restarting.'}
          </p>

          {status.phase === 'available' && info && info.notes.length > 0 && <ul className="update-dialog-notes">
            {info.notes.map((line, index) => <li key={index}>{line}</li>)}
          </ul>}
          {status.phase === 'error' && <small className="update-dialog-detail" title={status.detail}>{status.detail}</small>}
        </div>

        <div className="update-dialog-actions">
          {status.phase === 'available' && <>
            <button className="text-button" onClick={update.dismiss}>Not now</button>
            <button className="button primary" onClick={() => { setDialogOpen(false); void update.download(true) }}>
              <ArrowDownToLine size={15} /> Download in background
            </button>
          </>}
          {status.phase === 'ready' && <>
            <button className="text-button" onClick={() => setDialogOpen(false)}>Later</button>
            <button className="button primary" onClick={() => void update.install()}>
              <RefreshCw size={15} /> Restart to update
            </button>
          </>}
          {status.phase === 'error' && <>
            <button className="text-button" onClick={update.dismiss}>Not now</button>
            <button className="button outline" onClick={() => void update.retry()}><RefreshCw size={14} /> Try again</button>
          </>}
        </div>
      </section>
    </div>}
  </>
}
