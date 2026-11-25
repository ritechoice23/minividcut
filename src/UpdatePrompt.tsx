import { useEffect, useState } from 'react'
import { ArrowDownToLine, Check, RefreshCw, X } from 'lucide-react'
import { progressLabel, type AppUpdate } from './useAppUpdate'

const DIALOG_PHASES = ['available', 'ready', 'error'] as const

/** Unobtrusive update UI: a one-time dialog, then background progress and a
 * separate restart prompt so the editor stays usable throughout the download. */
export function UpdatePrompt({ update }: { update: AppUpdate }) {
  const { status } = update
  const info = 'info' in status ? status.info : null
  const [dialogOpen, setDialogOpen] = useState(true)
  const [progressHidden, setProgressHidden] = useState(false)
  const notice = status.phase === 'error' ? `error:${status.message}` : `${status.phase}:${info?.version ?? ''}`

  useEffect(() => {
    setDialogOpen(true)
    setProgressHidden(false)
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
    {status.phase === 'downloading' && !progressHidden && <div className="update-toast" role="status">
      <span className="update-toast-icon"><ArrowDownToLine size={15} /></span>
      <div className="update-toast-text">
        <strong>{progressLabel(status)}</strong>
        <progress max={100} value={status.percent ?? undefined} aria-label="Update download progress" />
        <small>Keep working — we’ll ask you to restart when it’s ready.</small>
      </div>
      <button className="icon-button compact" aria-label="Hide download progress" title="Hide progress"
        onClick={() => setProgressHidden(true)}><X size={14} /></button>
    </div>}

    {status.phase === 'downloading' && progressHidden && <button className="update-chip" type="button"
      title="Show download progress" onClick={() => setProgressHidden(false)}>
      <ArrowDownToLine size={13} /> Downloading v{version} · {status.percent ?? 0}%
    </button>}

    {status.phase === 'ready' && !dialogOpen && <div className="update-toast ready" role="status">
      <span className="update-toast-icon"><Check size={15} /></span>
      <div className="update-toast-text">
        <strong>Update ready</strong>
        <small>Restart whenever you’re ready to install v{version}.</small>
      </div>
      <button className="button primary small" onClick={() => void update.install()}>
        <RefreshCw size={13} /> Restart
      </button>
    </div>}

    {status.phase === 'installing' && <div className="update-toast" role="status">
      <span className="update-toast-icon"><RefreshCw size={15} /></span>
      <div className="update-toast-text">
        <strong>Installing update…</strong>
        <small>MiniVidCut will reopen on the new version.</small>
      </div>
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
              ? `Version ${version} is downloaded. Restart now to install it, or carry on editing and restart later.`
              : status.phase === 'error'
                ? status.message
                : 'Download it in the background and keep editing. We’ll ask you to restart once it’s ready.'}
          </p>

          {status.phase === 'available' && info && info.notes.length > 0 && <ul className="update-dialog-notes">
            {info.notes.map((line, index) => <li key={index}>{line}</li>)}
          </ul>}
          {status.phase === 'error' && <small className="update-dialog-detail" title={status.detail}>{status.detail}</small>}
        </div>

        <div className="update-dialog-actions">
          {status.phase === 'available' && <>
            <button className="text-button" onClick={update.dismiss}>Not now</button>
            <button className="button primary" onClick={() => { setDialogOpen(false); void update.download() }}>
              <ArrowDownToLine size={15} /> Download update
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
