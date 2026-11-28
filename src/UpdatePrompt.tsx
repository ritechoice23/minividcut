import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowDownToLine, Check, RefreshCw, X } from 'lucide-react'
import { formatBytes, RELEASES_URL, updateIndicatorLabel } from './updates'
import { progressLabel, type AppUpdate } from './useAppUpdate'

const CARD_PHASES = ['available', 'ready', 'error'] as const

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
  if (status.phase === 'ready') return <div className="update-indicator ready">
    <button type="button" className="update-indicator-main" title="Installs when you close MiniVidCut · click to restart now"
      onClick={() => void update.install()}><Check size={13} /> {label}</button>
    <button type="button" className="update-indicator-close" aria-label="Hide update reminder"
      title="Installs when you close MiniVidCut" onClick={update.deferInstall}><X size={11} /></button>
  </div>
  if (status.phase === 'error') return <button type="button" className="update-indicator error"
    title={status.detail} onClick={() => void update.retry()}><RefreshCw size={12} /> {label}</button>
  return <span className="update-indicator" title={title}>{label}</span>
}

/** Small corner card (never a blocking dialog) so the editor always stays usable. */
export function UpdatePrompt({ update }: { update: AppUpdate }) {
  const { status } = update
  const info = 'info' in status ? status.info : null
  const [cardOpen, setCardOpen] = useState(true)
  const notice = status.phase === 'error' ? `error:${status.message}` : `${status.phase}:${info?.version ?? ''}`

  useEffect(() => {
    setCardOpen(true)
  }, [notice])

  if (status.phase === 'idle' || status.phase === 'checking' || status.phase === 'current') return null
  const version = info?.version ?? ''
  const showCard = cardOpen && (CARD_PHASES as readonly string[]).includes(status.phase)
    && !(status.phase === 'ready' && update.progressHidden)

  return <>
    {status.phase === 'downloading' && !update.progressHidden && <div className="update-toast" role="status">
      <span className="update-toast-icon"><ArrowDownToLine size={15} /></span>
      <div className="update-toast-text">
        <strong>{progressLabel(status)}</strong>
        <progress max={100} value={status.percent ?? undefined} aria-label="Update download progress" />
        <small>Keep working. It installs when you close MiniVidCut.</small>
      </div>
      <button className="icon-button compact" aria-label="Hide download progress" title="Hide details. The download continues."
        onClick={update.hideProgress}><X size={14} /></button>
    </div>}

    {showCard && <div className="update-toast update-card" role="status" aria-live="polite">
      <span className={`update-toast-icon ${status.phase}`}>
        {status.phase === 'ready' ? <Check size={15} /> : status.phase === 'error' ? <RefreshCw size={15} /> : <ArrowDownToLine size={15} />}
      </span>
      <div className="update-toast-text">
        <strong>{status.phase === 'ready' ? `Version ${version} is ready`
          : status.phase === 'error' ? 'Update failed' : `Version ${version} is available`}</strong>
        <small>{status.phase === 'ready' ? 'It installs automatically when you close MiniVidCut.'
          : status.phase === 'error' ? status.message : 'Download it in the background while you keep editing.'}</small>
        {status.phase === 'error' && status.detail && <small className="update-detail" title="What the updater reported">{status.detail.slice(0, 160)}</small>}
        <div className="update-card-actions">
          {status.phase === 'available' && <>
            <button className="button primary small" onClick={() => void update.download(true)}><ArrowDownToLine size={13} /> Download</button>
            <button className="text-button" onClick={update.dismiss}>Not now</button>
          </>}
          {status.phase === 'ready' && <button className="button outline small" onClick={() => void update.install()}><RefreshCw size={13} /> Restart now</button>}
          {status.phase === 'error' && <>
            <button className="button outline small" onClick={() => void update.retry()}><RefreshCw size={13} /> Try again</button>
            <button className="text-button" onClick={() => void invoke('open_agent_link', { url: RELEASES_URL }).catch(() => {})}>Download by hand</button>
          </>}
        </div>
      </div>
      <button className="icon-button compact" aria-label="Hide update notice" title="Hide"
        onClick={() => { if (status.phase === 'ready') update.deferInstall(); else setCardOpen(false) }}><X size={14} /></button>
    </div>}
  </>
}
