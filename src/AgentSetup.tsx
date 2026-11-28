import { useCallback, useEffect, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'
import { ArrowUpRight, Cpu, LoaderCircle, LogIn, Sparkles } from 'lucide-react'
import { AGENTS, agentMessage, agentMeta, rowState } from './agents'
import type { AgentStatus, Health, RowState, Signin, TestResult } from './agents'
import { AGENT_IDS } from './preferences'
import type { AgentId, AiQuality, Preferences } from './preferences'

type Entry = {
  installed: boolean
  version: string | null
  signin: Signin
  health: Health | 'untested'
  message: string
  /** Sign-in page the tool printed, offered in case the browser did not open. */
  url: string | null
  /** The embedded sign-in did not finish, so offer a console window instead. */
  retryInTerminal: boolean
  /** A console window is open for sign-in; the user says when they are done. */
  console: boolean
}

const blank = (): Entry => ({ installed: false, version: null, signin: 'unknown', health: 'untested', message: '', url: null, retryInTerminal: false, console: false })
const initial = () => Object.fromEntries(AGENT_IDS.map(id => [id, blank()])) as Record<AgentId, Entry>

const QUALITY: { value: AiQuality; label: string; detail: string }[] = [
  { value: 'fast', label: 'Fast', detail: 'Quicker and lighter on your plan' },
  { value: 'best', label: 'Best', detail: 'Smarter picks, a little slower' },
]

/**
 * Picks who finds clips: this device or an assistant already installed on the
 * PC. Signing in runs the assistant's own sign-in, so MiniVidCut never sees a
 * password or token. `only` shows a single assistant, for fixing a sign-in
 * from the Find panel.
 */
export function AgentSetup({ preferences, onPreferences, localReady, only, onDone, visible = true }: {
  preferences: Preferences
  onPreferences: (preferences: Preferences) => void
  localReady?: boolean
  only?: AgentId
  onDone?: () => void
  /** False while the page holding this is hidden; it checks again when shown. */
  visible?: boolean
}) {
  const [entries, setEntries] = useState(initial)
  const [busy, setBusy] = useState<{ id: AgentId; kind: 'login' | 'test' } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState(preferences.aiModel)
  const latest = useRef(preferences)
  latest.current = preferences
  const busyNow = useRef(busy)
  busyNow.current = busy

  const patch = useCallback((id: AgentId, change: Partial<Entry>) =>
    setEntries(current => ({ ...current, [id]: { ...current[id], ...change } })), [])

  const refresh = useCallback(async () => {
    try {
      const found = await invoke<AgentStatus[]>('detect_agents')
      const signins = await Promise.all(found.map(item => item.installed
        ? invoke<Signin>('agent_signin_state', { provider: item.id }).catch(() => 'unknown' as Signin)
        : Promise.resolve('unknown' as Signin)))
      setEntries(current => {
        const next = { ...current }
        found.forEach((item, index) => {
          const signin = signins[index]
          // A login that has gone away is no longer proven to work.
          next[item.id] = { ...current[item.id], installed: item.installed, version: item.version, signin, health: signin === 'out' ? 'untested' : current[item.id].health }
        })
        return next
      })
    } catch { /* not running inside the app */ }
  }, [])

  // Coming back from the browser (or an install) refreshes what is shown.
  useEffect(() => {
    if (!visible) return
    void refresh()
    const onFocus = () => { if (!busyNow.current) void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, visible])

  const opencodeChosen = preferences.aiProvider === 'opencode' && entries.opencode.installed
  useEffect(() => {
    if (!opencodeChosen || models.length) return
    void invoke<string[]>('opencode_models').then(setModels).catch(() => {})
  }, [opencodeChosen, models.length])

  async function select(id: AgentId) {
    const meta = agentMeta(id)
    let consent = latest.current.aiConsent
    if (!consent[id]) {
      const agreed = await confirm(
        `${meta.name} will receive the text of your video’s transcript to pick clips. Your video and audio never leave this PC. This counts toward ${meta.plan}.`,
        { title: `Use ${meta.name}?`, okLabel: `Use ${meta.name}` },
      )
      if (!agreed) return
      consent = { ...consent, [id]: true }
    }
    setBusy({ id, kind: 'test' })
    patch(id, { message: '', retryInTerminal: false })
    try {
      const result = await invoke<TestResult>('test_agent', {
        provider: id, quality: latest.current.aiQuality, model: id === 'opencode' ? latest.current.aiModel || null : null,
      })
      patch(id, { health: result.health, message: result.message ?? '' })
      const chosen = result.health === 'ready'
      onPreferences({ ...latest.current, aiConsent: consent, ...(chosen ? { aiProvider: id } : {}) })
      if (chosen) onDone?.()
    } catch (error) {
      patch(id, { health: 'failed', message: agentMessage(error, meta.name) })
    } finally {
      setBusy(null)
    }
  }

  async function signIn(id: AgentId, terminal = agentMeta(id).terminal) {
    const meta = agentMeta(id)
    setBusy({ id, kind: 'login' })
    patch(id, { message: '', url: null, retryInTerminal: false, console: false })
    const urls = new Channel<string>()
    urls.onmessage = url => patch(id, { url })
    try {
      await invoke('agent_login', { provider: id, terminal, urls })
    } catch (error) {
      const text = typeof error === 'string' ? error : ''
      setBusy(null)
      patch(id, { url: null, message: text === 'canceled' ? '' : text || `Couldn’t sign in to ${meta.name}.`, retryInTerminal: !terminal && text !== 'canceled' })
      await refresh()
      return
    }
    patch(id, { url: null })
    if (terminal) {
      // The window stays open until the user finishes; they tell us when.
      setBusy(null)
      patch(id, { console: true })
      return
    }
    await refresh()
    setBusy(null)
    await select(id)
  }

  async function finishConsole(id: AgentId) {
    patch(id, { console: false })
    await refresh()
    await select(id)
  }

  const open = (url: string) => void invoke('open_agent_link', { url }).catch(() => {})
  const stateOf = (id: AgentId): RowState =>
    rowState({ installed: entries[id].installed, signin: entries[id].signin, health: entries[id].health, busy: busy?.id === id ? busy.kind : entries[id].console ? 'login' : null })

  function choose(id: AgentId) {
    const state = stateOf(id)
    if (busy || state === 'missing') return
    if (state === 'signedout') void signIn(id)
    else if (state === 'ready') onPreferences({ ...latest.current, aiProvider: id })
    else void select(id)
  }

  const detail = (id: AgentId, state: RowState) => {
    const meta = agentMeta(id)
    const entry = entries[id]
    switch (state) {
      case 'missing': return 'Not installed'
      case 'installed': return `Installed${entry.version ? ` · ${entry.version}` : ''}`
      case 'signedout': return entry.message || 'Not signed in'
      case 'signedin': return `Signed in · uses ${meta.plan}`
      case 'ready': return `Ready · uses ${meta.plan}`
      case 'error': return entry.message || 'Something went wrong'
      case 'verifying': return 'Checking that it works…'
      case 'waiting': return entry.console ? 'Finish in the window that opened, then click Done.' : 'Finish signing in in your browser…'
    }
  }

  const action = (id: AgentId, state: RowState) => {
    const meta = agentMeta(id)
    switch (state) {
      case 'missing': return <button className="button outline small" onClick={() => open(meta.install)}>Get it <ArrowUpRight size={13} /></button>
      case 'signedout': return <button className="button primary small" disabled={busy !== null} onClick={() => void signIn(id)}><LogIn size={13} /> {entries[id].message ? 'Sign in again' : meta.terminal ? 'Connect' : 'Sign in'}</button>
      case 'waiting': return entries[id].console
        ? <><button className="button primary small" onClick={() => void finishConsole(id)}>Done</button>
          <button className="button ghost small" onClick={() => patch(id, { console: false })}>Cancel</button></>
        : <button className="button outline small" onClick={() => void invoke('cancel_agent_job').catch(() => {})}>Cancel</button>
      case 'verifying': return <LoaderCircle size={16} className="spin" aria-label="Checking" />
      case 'ready': return <span className="ok-chip">✓ Ready</span>
      case 'error': return <button className="button outline small" disabled={busy !== null} onClick={() => void select(id)}>Try again</button>
      default: return <button className="button outline small" disabled={busy !== null} onClick={() => void select(id)}>Use</button>
    }
  }

  const shown = only ? AGENTS.filter(agent => agent.id === only) : AGENTS
  const picked = preferences.aiProvider
  const hasQuality = !only && (picked === 'claude' || picked === 'codex') && entries[picked].installed

  return <div className="agent-setup">
    <div className="agent-list" role="radiogroup" aria-label="Find clips with">
      {!only && <div className="agent-row" data-selected={picked === 'local'}>
        <button type="button" role="radio" className="agent-radio" aria-checked={picked === 'local'} aria-label="Use this device"
          disabled={busy !== null} onClick={() => onPreferences({ ...latest.current, aiProvider: 'local' })} />
        <span className="model-icon"><Cpu size={18} /></span>
        <div className="settings-row-text"><b>This device</b><small>Free · works offline · nothing leaves your PC</small></div>
        {localReady ? <span className="ok-chip">✓ Ready</span> : <small className="agent-hint">Downloads on first use</small>}
      </div>}
      {shown.map(agent => {
        const state = stateOf(agent.id)
        const entry = entries[agent.id]
        return <div className="agent-row" key={agent.id} data-selected={picked === agent.id} data-state={state}>
          {!only && <button type="button" role="radio" className="agent-radio" aria-checked={picked === agent.id} aria-label={`Use ${agent.name}`}
            disabled={busy !== null || state === 'missing'} onClick={() => choose(agent.id)} />}
          <span className="model-icon"><Sparkles size={18} /></span>
          <div className="settings-row-text">
            <b>{agent.name}{agent.experimental && <span className="agent-tag">Experimental</span>}</b>
            <small className={state === 'error' || (state === 'signedout' && entry.message) ? 'agent-problem' : undefined} role={state === 'error' ? 'alert' : undefined}>{detail(agent.id, state)}</small>
            {state === 'waiting' && entry.url && <small><button type="button" className="link-button" onClick={() => open(entry.url!)}>Open the sign-in page again</button></small>}
            {entry.retryInTerminal && <small><button type="button" className="link-button" onClick={() => void signIn(agent.id, true)}>Sign in using a window instead</button></small>}
          </div>
          {action(agent.id, state)}
        </div>
      })}
    </div>
    {hasQuality && <div className="settings-row">
      <div className="settings-row-text"><b>Quality</b><small>{QUALITY.find(item => item.value === preferences.aiQuality)?.detail}</small></div>
      <div className="seg" role="group" aria-label="Assistant quality">
        {QUALITY.map(item => <button key={item.value} aria-pressed={preferences.aiQuality === item.value}
          onClick={() => onPreferences({ ...preferences, aiQuality: item.value })}>{item.label}</button>)}
      </div>
    </div>}
    {!only && picked === 'opencode' && entries.opencode.installed && <div className="settings-row">
      <div className="settings-row-text"><b>Model</b><small>Leave empty to use the one set in OpenCode</small></div>
      <input className="agent-model" list="agent-models" value={model} placeholder="provider/model" aria-label="OpenCode model" maxLength={120} spellCheck={false}
        onChange={event => setModel(event.target.value)}
        onBlur={() => { if (model.trim() !== preferences.aiModel) onPreferences({ ...preferences, aiModel: model.trim() }) }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <datalist id="agent-models">{models.map(name => <option key={name} value={name} />)}</datalist>
    </div>}
    {!only && <p className="agent-note">An assistant only receives transcript text, never your video or audio. MiniVidCut never sees your sign-in.</p>}
  </div>
}
