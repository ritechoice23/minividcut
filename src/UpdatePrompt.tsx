import { ArrowDownToLine, RefreshCw, X } from 'lucide-react'
import { progressLabel, type AppUpdate } from './useAppUpdate'

/** Non-blocking, in-app prompt shown when a signed update is available. */
export function UpdatePrompt({ update }: { update: AppUpdate }) {
  const { status } = update
  if (status.phase === 'idle' || status.phase === 'checking' || status.phase === 'current') return null

  const info = 'info' in status ? status.info : null
  const title = status.phase === 'error'
    ? 'Update failed'
    : status.phase === 'installing'
      ? 'Installing update…'
      : status.phase === 'downloading'
        ? progressLabel(status)
        : `MiniVidCut v${info?.version} is available`

  return <aside className={`update-prompt panel ${status.phase}`} aria-label="Application update">
    <div className="update-prompt-head">
      <span className="update-prompt-icon"><ArrowDownToLine size={16} /></span>
      <div className="update-prompt-title">
        <strong>{title}</strong>
        {status.phase === 'installing' && <small>MiniVidCut will restart when the install finishes.</small>}
        {status.phase === 'available' && info?.notes.length ? <small>{info.notes[0]}</small> : null}
        {status.phase === 'error' && <small title={status.detail}>{status.message}</small>}
      </div>
      {status.phase !== 'installing' && status.phase !== 'downloading' &&
        <button className="icon-button" aria-label="Dismiss update prompt" title="Not now" onClick={update.dismiss}><X size={15} /></button>}
    </div>

    {status.phase === 'available' && <>
      {info && info.notes.length > 1 && <ul className="update-prompt-notes">
        {info.notes.slice(1).map((line, index) => <li key={index}>{line}</li>)}
      </ul>}
      <div className="update-prompt-actions">
        <button className="text-button" onClick={update.dismiss}>Not now</button>
        <button className="button primary small" onClick={() => void update.install()}>
          <ArrowDownToLine size={14} /> Update & restart
        </button>
      </div>
    </>}

    {status.phase === 'downloading' && <div className="update-prompt-progress">
      <progress max={100} value={status.percent ?? undefined} aria-label="Update download progress" />
      <small>{status.percent !== null ? `${status.percent}%` : 'Starting…'}</small>
    </div>}

    {status.phase === 'error' && <div className="update-prompt-actions">
      <button className="text-button" onClick={update.dismiss}>Not now</button>
      <button className="button outline small" onClick={() => void update.retry()}><RefreshCw size={13} /> Try again</button>
    </div>}
  </aside>
}
