import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Clapperboard } from 'lucide-react'
import { effectiveBookends, TRANSITIONS } from './bookends'
import type { Bookend, Bookends } from './bookends'

type Props = {
  project: Bookends
  clip: { bookends?: Bookends; title: string } | null
  disabled: boolean
  videoExtensions: string[]
  onChange: (scope: 'project' | 'clip', end: keyof Bookends, value: Bookend | null | undefined) => void
}

export function BookendsMenu({ project, clip, disabled, videoExtensions, onChange }: Props) {
  const [scope, setScope] = useState<'project' | 'clip'>('clip')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const target = clip ? scope : 'project'
  const current = target === 'project' ? project : clip?.bookends
  const active = effectiveBookends(project, clip?.bookends)

  async function select(end: keyof Bookends, value: string) {
    setError('')
    if (value === 'inherit' || value === 'off') {
      onChange(target, end, value === 'inherit' ? undefined : null)
      return
    }
    setPending(true)
    try {
      const path = await open({ title: `Choose an ${end} video`, filters: [{ name: 'Video files', extensions: videoExtensions }] })
      if (!path) return
      const info = await invoke<{ path: string; name: string }>('inspect_bookend', { path })
      onChange(target, end, { path: info.path, name: info.name, transition: active[end]?.transition ?? 'cut' })
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }

  return <>
    <button type="button" className="icon-button bookends-trigger" title="Intro and outro" aria-label="Intro and outro"
      aria-haspopup="dialog" popoverTarget="bookends-menu" data-active={Boolean(active.intro || active.outro)} disabled={disabled}>
      <Clapperboard size={17} />
    </button>
    <div id="bookends-menu" className="bookends-menu media-menu panel" popover="auto" role="dialog"
      aria-label="Intro and outro" onKeyDown={event => event.stopPropagation()}>
      <strong>Intro and outro</strong>
      {clip && <label>Apply to
        <select aria-label="Apply to" value={target} disabled={disabled || pending}
          onChange={event => setScope(event.target.value === 'clip' ? 'clip' : 'project')}>
          <option value="project">All clips</option>
          <option value="clip">{clip.title}</option>
        </select>
      </label>}
      {(['intro', 'outro'] as const).map(end => {
        const selected = current?.[end]
        const label = end === 'intro' ? 'Intro' : 'Outro'
        const transitionVideo = target === 'project' ? project[end] : active[end]
        const value = selected ? 'file' : selected === undefined && target === 'clip' ? 'inherit' : 'off'
        return <div className="bookend-fields" key={end}>
          <label>{label}
            <select aria-label={label} value={value} disabled={disabled || pending} onChange={event => void select(end, event.target.value)}>
              {target === 'clip' && <option value="inherit">Use project {end}</option>}
              <option value="off">No {end}</option>
              {selected && <option value="file" disabled>{selected.name}</option>}
              <option value="browse">Choose a video…</option>
            </select>
          </label>
          {transitionVideo && <label>{label} transition
            <select aria-label={`${label} transition`} value={transitionVideo.transition}
              disabled={disabled || pending} onChange={event => {
                const transition = TRANSITIONS.find(item => item.value === event.target.value)?.value
                if (transition) onChange(target, end, { ...transitionVideo, transition })
              }}>
              {TRANSITIONS.map(item => <option key={item.value} value={item.value}>{item.name}</option>)}
            </select>
          </label>}
        </div>
      })}
      <small>Added when you export.</small>
      {pending && <small role="status">Opening video…</small>}
      {error && <small role="alert">{error}</small>}
    </div>
  </>
}
