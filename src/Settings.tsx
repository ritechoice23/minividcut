import { useEffect, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { confirm } from '@tauri-apps/plugin-dialog'
import { ArrowDownToLine, ArrowLeft, AudioLines, Info, Scissors, Sparkles, Trash2 } from 'lucide-react'

const MODEL_INFO = {
  speech: { name: 'Parakeet TDT 0.6B', description: 'Transcription and automatic captions', icon: AudioLines },
  language: { name: 'LFM2.5 350M', description: 'Clip titles and Smart Split', icon: Sparkles },
}
type LocalModel = { id: keyof typeof MODEL_INFO; bytes: number; installed: boolean }

export function Settings({ open, onClose, onModelsChanged }: { open: boolean; onClose: () => void; onModelsChanged: (removed: boolean) => void }) {
  const [page, setPage] = useState<'about' | 'models'>('about')
  const [models, setModels] = useState<LocalModel[]>([])
  const [version, setVersion] = useState('')
  const [pending, setPending] = useState<LocalModel['id'] | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open || page !== 'models' || pending) return
    let active = true
    void invoke<LocalModel[]>('local_models').then(result => {
      if (active) setModels(result)
    }).catch(() => {
      if (active) setStatus('Couldn’t check downloaded models.')
    })
    return () => { active = false }
  }, [open, page, pending])
  useEffect(() => { if (open && !version) void getVersion().then(setVersion).catch(() => {}) }, [open, version])

  async function changeModel(model: LocalModel) {
    setPending(model.id)
    setStatus('')
    setProgress(null)
    try {
      const name = MODEL_INFO[model.id].name
      if (model.installed && !await confirm(
        `Remove ${name} from this device? You can download it again whenever you need it.`,
        { title: 'Remove model?', okLabel: 'Remove' },
      )) return
      setStatus(model.installed ? 'Removing model…' : 'Downloading model…')
      const channel = new Channel<string>()
      channel.onmessage = update => {
        if (!model.installed) {
          const percent = update.match(/(\d+)%$/)
          setProgress(percent ? Number(percent[1]) : null)
          setStatus(update)
        }
      }
      await invoke('manage_local_model', { id: model.id, install: !model.installed, progress: channel })
      onModelsChanged(model.installed)
      setModels(await invoke<LocalModel[]>('local_models'))
      setStatus(model.installed ? `${name} removed.` : `${name} is ready.`)
    } catch (error) {
      setStatus(typeof error === 'string' && error.startsWith('Wait for ') ? error : 'Couldn’t update the model. Try again.')
    } finally {
      setPending(null)
    }
  }

  return <section className="settings-page" aria-label="Settings" hidden={!open}>
    <nav className="settings-nav" aria-label="Settings sections">
      <button className="text-button" onClick={onClose}><ArrowLeft size={15} /> Back to editor</button>
      <button className="settings-link" aria-current={page === 'about' ? 'page' : undefined} onClick={() => setPage('about')}><Info size={16} /> About</button>
      <button className="settings-link" aria-current={page === 'models' ? 'page' : undefined} onClick={() => setPage('models')}><AudioLines size={16} /> Models</button>
    </nav>
    <div className="settings-content">
      {page === 'about' ? <>
        <div className="settings-product"><span className="brand-mark"><Scissors size={17} /></span><h1>MiniVidCut</h1>{version && <span className="settings-meta">v{version}</span>}</div>
        <p>Turn long videos into short clips.</p>
        <div className="settings-card"><div><strong>Daramola Babatunde</strong><small>Creator of MiniVidCut</small></div>
          <a className="source-arrow-link" href="https://github.com/ritechoice23" target="_blank" rel="noopener noreferrer" aria-label="Open Daramola Babatunde’s GitHub profile">↗</a>
        </div>
      </> : <>
        <h1>Models</h1>
        <p>Download models for features that run on this device.</p>
        {models.map(model => {
          const { name, description, icon: Icon } = MODEL_INFO[model.id]
          return <div className="settings-card" key={model.id}>
            <Icon size={19} />
            <div><strong>{name}</strong><small>{description} · {Math.round(model.bytes / 1_000_000)} MB</small></div>
            {model.installed && <span className="settings-installed">Downloaded</span>}
            <button className="button outline small" disabled={pending !== null}
              aria-label={`${model.installed ? 'Remove' : 'Download'} ${name}`} onClick={() => void changeModel(model)}>
              {model.installed ? <Trash2 size={14} /> : <ArrowDownToLine size={14} />}
              {model.installed ? 'Remove' : 'Download'}
            </button>
          </div>
        })}
        {pending && status && <progress aria-label="Model update progress" max={100} value={progress ?? undefined} />}
        {status && <p role="status">{status}</p>}
      </>}
    </div>
  </section>
}
