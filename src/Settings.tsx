import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { confirm } from '@tauri-apps/plugin-dialog'
import { ArrowDownToLine, ArrowLeft, AudioLines, Info, Keyboard, LoaderCircle, Monitor, RefreshCw, Scissors, Search, Smartphone, Sparkles } from 'lucide-react'
import type { AppUpdate } from './useAppUpdate'
import { fileNameExample, QUALITY_OPTIONS } from './preferences'
import type { FileNameParts, Preferences } from './preferences'
import { SHORTCUTS } from './shortcuts'
import { AgentSetup } from './AgentSetup'
import { agentMeta } from './agents'

const MODEL_INFO = {
  speech: { name: 'Speech · Parakeet TDT 0.6B', description: 'Transcript, captions and the timeline Words lane', icon: AudioLines },
  language: { name: 'Language · LFM2.5 350M', description: 'Find clips (Smart Split) and AI titles', icon: Sparkles },
}
type LocalModel = { id: keyof typeof MODEL_INFO; bytes: number; installed: boolean }
export type Section = 'exporting' | 'ai' | 'shortcuts' | 'updates' | 'about'
const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'exporting', label: 'Exporting', icon: <ArrowDownToLine size={16} /> },
  { id: 'ai', label: 'AI', icon: <Sparkles size={16} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={16} /> },
  { id: 'updates', label: 'Updates', icon: <RefreshCw size={16} /> },
  { id: 'about', label: 'About', icon: <Info size={16} /> },
]
const NAME_PARTS: [keyof FileNameParts, string][] = [['video', 'Original video name'], ['number', 'Clip number'], ['title', 'Clip title']]
const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`
const kilobytes = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`

function updateSummary(status: AppUpdate['status']): string {
  switch (status.phase) {
    case 'checking': return 'Checking for updates…'
    case 'current': return 'You’re up to date'
    case 'available': return `Version ${status.info.version} is available`
    case 'downloading': return `Downloading… ${status.percent !== null ? `${status.percent}%` : ''}`.trim()
    case 'ready': return `Version ${status.info.version} is downloaded`
    case 'installing': return 'Installing update… MiniVidCut will restart'
    case 'error': return status.message
    default: return 'Check for a newer version'
  }
}

function Switch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: () => void; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange} />
}

function Row({ title, detail, children, hidden }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; hidden?: boolean }) {
  if (hidden) return null
  return <div className="settings-row"><div className="settings-row-text"><b>{title}</b>{detail && <small>{detail}</small>}</div>{children}</div>
}

export function Settings({
  open, onClose, onModelsChanged, update, preferences, onPreferences, projectName, projectMeta, section,
  autoTitles, onToggleAutoTitles, exportFolder, onChooseExportFolder, onClearExportFolder,
}: {
  open: boolean; onClose: () => void; onModelsChanged: (removed: boolean) => void; update: AppUpdate
  /** Opens on this section when set, for example from a link in the Find panel. */
  section?: Section
  preferences: Preferences; onPreferences: (preferences: Preferences) => void
  projectName: string; projectMeta: string
  autoTitles: boolean; onToggleAutoTitles: () => void
  exportFolder: string; onChooseExportFolder: () => void; onClearExportFolder: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<Section>('exporting')
  const [models, setModels] = useState<LocalModel[]>([])
  const [version, setVersion] = useState('')
  const [pending, setPending] = useState<{ id: LocalModel['id']; install: boolean } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [status, setStatus] = useState('')
  /** Size of the saved transcripts that spare the speech model from listening twice. */
  const [savedBytes, setSavedBytes] = useState(0)
  const toggleNamePart = (key: keyof FileNameParts) => {
    const next = { ...preferences.fileNameParts, [key]: !preferences.fileNameParts[key] }
    if (next.video || next.number || next.title) onPreferences({ ...preferences, fileNameParts: next })
  }
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onPreferences({ ...preferences, [key]: value })

  useEffect(() => {
    if (!open || pending) return
    let active = true
    void invoke<number>('transcript_cache_bytes').then(bytes => { if (active) setSavedBytes(bytes) }).catch(() => {})
    void invoke<LocalModel[]>('local_models').then(result => {
      if (active) setModels(result)
    }).catch(() => {
      if (active) setStatus('Couldn’t check downloaded models.')
    })
    return () => { active = false }
  }, [open, pending])
  useEffect(() => { if (open && section) setActive(section) }, [open, section])
  useEffect(() => { if (open && !version) void getVersion().then(setVersion).catch(() => {}) }, [open, version])
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (event.target instanceof Element && event.target.closest('input')) return
      onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onClose])

  async function changeModel(model: LocalModel) {
    const name = MODEL_INFO[model.id].name
    if (model.installed && !await confirm(
      `Remove ${name} from this device? You can download it again whenever you need it.`,
      { title: 'Remove model?', okLabel: 'Remove' },
    )) return
    setPending({ id: model.id, install: !model.installed })
    setStatus(model.installed ? 'Removing model…' : 'Starting download…')
    setProgress(null)
    try {
      const channel = new Channel<string>()
      channel.onmessage = message => {
        if (model.installed) return
        const percent = message.match(/(\d+)%$/)
        setProgress(percent ? Number(percent[1]) : null)
        setStatus(message)
      }
      await invoke('manage_local_model', { id: model.id, install: !model.installed, progress: channel })
      onModelsChanged(model.installed)
      setModels(await invoke<LocalModel[]>('local_models'))
      setStatus(model.installed ? `${name} removed.` : `${name} is ready.`)
    } catch (error) {
      const text = typeof error === 'string' ? error : ''
      setStatus(text === 'Download canceled.' || text === 'Caption generation canceled.' ? 'Download canceled.'
        : text.startsWith('Wait for ') ? text : 'Couldn’t update the model. Try again.')
    } finally {
      setPending(null)
      setProgress(null)
    }
  }

  const match = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (...text: string[]) => !words.length || words.every(word => text.join(' ').toLowerCase().includes(word))
  }, [query])
  const used = models.filter(model => model.installed).reduce((sum, model) => sum + model.bytes, 0)
  const updateAction = update.status.phase === 'available'
    ? <button className="button primary small" onClick={() => void update.download(true)}><ArrowDownToLine size={14} /> Download</button>
    : update.status.phase === 'ready'
      ? <button className="button primary small" onClick={() => void update.install()}><RefreshCw size={13} /> Restart to update</button>
      : update.status.phase === 'error'
        ? <button className="button outline small" onClick={() => void update.retry()}><RefreshCw size={13} /> Retry</button>
        : <button className="button outline small" disabled={update.status.phase !== 'idle' && update.status.phase !== 'current'}
          onClick={() => void update.checkForUpdates(true)}>{update.status.phase === 'checking' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Check now</button>

  const show = {
    folder: match('save clips to export folder location'),
    format: match('default format vertical landscape 9:16 16:9 shape'),
    quality: match('default quality compact compatible lossless'),
    names: match('file names title number'),
    openFolder: match('open folder when export finishes'),
    models: match('ai assistant claude code codex opencode sign in connect models speech language download remove parakeet lfm captions find titles storage'),
    autoTitles: match('auto title new clips ai name'),
    autoCaption: match('caption new clips automatically'),
    shortcuts: match('shortcuts keyboard keys', ...SHORTCUTS.flat()),
    updates: match('updates check version'),
    background: match('download updates background'),
    about: match('about version creator license notices'),
  }
  const visible = {
    exporting: show.folder || show.format || show.quality || show.names || show.openFolder,
    ai: show.models || show.autoTitles || show.autoCaption,
    shortcuts: show.shortcuts,
    updates: show.updates || show.background,
    about: show.about,
  }

  const shown = Object.fromEntries(SECTIONS.map(({ id }) => [id, visible[id] && (query ? true : active === id)])) as Record<Section, boolean>

  return <section className="settings-page" aria-label="Settings" hidden={!open}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <button className="pill settings-back" onClick={onClose}><ArrowLeft size={14} /> Back to editor <kbd>Esc</kbd></button>
        <h1 className="display-title">Settings</h1>
        <label className="settings-search"><Search size={15} aria-hidden="true" />
          <input type="search" placeholder="Search settings" aria-label="Search settings" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        {SECTIONS.map(section => <button key={section.id} className="settings-link" disabled={!visible[section.id]}
          aria-current={shown[section.id] && (!query || active === section.id) ? 'page' : undefined}
          onClick={() => { setQuery(''); setActive(section.id) }}>
          {section.icon} {section.label}</button>)}
        <p className="settings-version">MiniVidCut {version}<br />Your videos never leave this PC.{preferences.aiProvider !== 'local' && <><br />Transcript text goes to {agentMeta(preferences.aiProvider).name}.</>}</p>
      </nav>
      <div className="settings-content">
          {shown.exporting && <section className="settings-card" id="settings-exporting">
            <h2>Exporting</h2><p className="lead">Set these once and Export never asks again.</p>
            <Row hidden={!show.folder} title="Save clips to" detail={<span className="mono" title={exportFolder || undefined}>{exportFolder || 'Not set — you are asked for each export'}</span>}>
              <button className="button outline small" onClick={onChooseExportFolder}>{exportFolder ? 'Change' : 'Choose'}</button>
              {exportFolder && <button className="button ghost small" onClick={onClearExportFolder}>Ask every time</button>}
            </Row>
            <Row hidden={!show.format} title="Default format" detail="New projects start in this shape">
              <div className="seg" role="group" aria-label="Default format">
                <button aria-pressed={preferences.defaultFormat === 'portrait'} onClick={() => set('defaultFormat', 'portrait')}><Smartphone size={13} /> Vertical 9:16</button>
                <button aria-pressed={preferences.defaultFormat === 'landscape'} onClick={() => set('defaultFormat', 'landscape')}><Monitor size={13} /> 16:9</button>
              </div>
            </Row>
            <Row hidden={!show.quality} title="Default quality" detail={QUALITY_OPTIONS.find(option => option.value === preferences.defaultQuality)?.detail}>
              <div className="seg" role="group" aria-label="Default quality">
                {QUALITY_OPTIONS.map(option => <button key={option.value} aria-pressed={preferences.defaultQuality === option.value}
                  onClick={() => set('defaultQuality', option.value)}>{option.title}</button>)}
              </div>
            </Row>
            <Row hidden={!show.names} title="File names" detail={<>Pick what goes in each file name. Example: <span className="mono">{fileNameExample(preferences.fileNameParts)}.mp4</span></>}>
              <div className="seg" role="group" aria-label="File name parts">
                {NAME_PARTS.map(([key, label]) => <button key={key} aria-pressed={preferences.fileNameParts[key]}
                  onClick={() => toggleNamePart(key)}>{label}</button>)}
              </div>
            </Row>
            <Row hidden={!show.openFolder} title="Open folder when export finishes">
              <Switch label="Open folder when export finishes" checked={preferences.openFolderAfterExport} onChange={() => set('openFolderAfterExport', !preferences.openFolderAfterExport)} />
            </Row>
          </section>}
          {shown.updates && <section className="settings-card" id="settings-updates">
            <h2>Updates</h2>
            <Row hidden={!show.updates} title={updateSummary(update.status)} detail={version ? `Installed version ${version}` : undefined}>{updateAction}</Row>
            <Row hidden={!show.background} title="Download updates in the background" detail="You’re always asked before the app restarts">
              <Switch label="Download updates in the background" checked={preferences.backgroundUpdates} onChange={() => set('backgroundUpdates', !preferences.backgroundUpdates)} />
            </Row>
          </section>}
          {shown.ai && <section className="settings-card" id="settings-ai">
            <h2>AI</h2><p className="lead">Choose what finds your clips. Use an assistant you already have, or run everything on this PC.</p>
            {show.models && <AgentSetup visible={open} preferences={preferences} onPreferences={onPreferences} localReady={models.some(model => model.id === 'language' && model.installed)} />}
            {show.models && <h3 className="agent-subhead">On this device</h3>}
            {show.models && <p className="lead">Download once. These run offline on your PC.</p>}
            {show.models && models.map(model => {
              const { name, description, icon: Icon } = MODEL_INFO[model.id]
              const busy = pending?.id === model.id
              return <div className="model-card" key={model.id}>
                <span className="model-icon"><Icon size={19} /></span>
                <div className="settings-row-text"><b>{name}</b><small>{description} · {megabytes(model.bytes)}</small>
                  {busy && pending.install && <>
                    <span className="thin-bar"><i style={{ width: `${progress ?? 0}%` }} /></span>
                    <small role="status">{status}</small>
                  </>}
                </div>
                {busy ? pending.install
                  ? <button className="button outline small" onClick={() => void invoke('cancel_model_download', { id: model.id }).catch(() => {})}>Cancel</button>
                  : <LoaderCircle size={16} className="spin" aria-label="Removing" />
                  : model.installed ? <>
                    <span className="ok-chip">✓ Ready</span>
                    <button className="button ghost small" disabled={pending !== null} aria-label={`Remove ${name}`} onClick={() => void changeModel(model)}>Remove</button>
                  </> : <button className="button outline small" disabled={pending !== null} aria-label={`Download ${name}`}
                    onClick={() => void changeModel(model)}><ArrowDownToLine size={14} /> Download</button>}
              </div>
            })}
            {show.models && status && !pending && <p className="settings-status" role="status">{status}</p>}
            <Row hidden={!show.models} title="Saved transcripts"
              detail={`${savedBytes ? kilobytes(savedBytes) : 'Nothing saved yet'} · videos are only listened to once, so searches, captions and titles reuse them`}>
              <button className="button ghost small" disabled={!savedBytes} onClick={() => {
                void invoke('clear_transcript_cache').then(() => setSavedBytes(0)).catch(() => setStatus('Couldn’t clear the saved transcripts.'))
              }}>Clear</button>
            </Row>
            <Row hidden={!show.autoTitles} title="Auto-title new clips" detail="Name each clip from what is said in it">
              <Switch label="Auto-title new clips" checked={autoTitles} onChange={onToggleAutoTitles} />
            </Row>
            <Row hidden={!show.autoCaption} title="Caption new clips automatically" detail="Runs in the background after a clip is added, once the speech model is downloaded">
              <Switch label="Caption new clips automatically" checked={preferences.autoCaption} onChange={() => set('autoCaption', !preferences.autoCaption)} />
            </Row>
            {show.models && <p className="settings-foot">Using {megabytes(used)} on this device</p>}
          </section>}
          {shown.shortcuts && <section className="settings-card" id="settings-shortcuts">
            <h2>Shortcuts</h2>
            <dl className="shortcut-list">{SHORTCUTS.filter(([label, key]) => match(label, key, 'shortcuts keyboard keys')).map(([label, key]) =>
              <div key={label}><dt>{label}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl>
          </section>}
          {shown.about && <section className="settings-card" id="settings-about">
            <h2>About</h2>
            <Row title={<span className="settings-product"><span className="brand-mark"><Scissors size={14} /></span> MiniVidCut {version}</span>} detail="Turn long videos into shorts with less editing">
              <a className="button ghost small" href="https://github.com/ritechoice23/minividcut/releases" target="_blank" rel="noopener noreferrer">What’s new</a>
            </Row>
            <Row title={<><a className="source-arrow-link" href="https://github.com/ritechoice23" target="_blank" rel="noopener noreferrer"
              aria-label="Open Daramola Babatunde’s GitHub profile" title="Open Source">↗</a> <strong>Daramola Babatunde</strong></>}
              detail="Creator · MIT license · third-party notices are installed with the app" />
          </section>}
          {!Object.values(visible).some(Boolean) && <p className="settings-status">No setting matches “{query}”.</p>}
      </div>
    </div>
    <p className="settings-saved">Changes save automatically</p>
  </section>
}
