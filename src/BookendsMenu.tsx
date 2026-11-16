import { useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Play, X } from 'lucide-react'
import { CENTER, frameTravel, panPosition } from './framing'
import { effectiveBookends, TRANSITIONS } from './bookends'
import type { Bookend, Bookends } from './bookends'

type Props = {
  project: Bookends
  clip: { bookends?: Bookends; title: string } | null
  disabled: boolean
  videoExtensions: string[]
  aspect: number
  open: boolean
  canPreview: boolean
  onPreview: () => void
  onClose: () => void
  onChange: (scope: 'project' | 'clip', end: keyof Bookends, value: Bookend | null | undefined) => void
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp']

export function BookendsMenu({ project, clip, disabled, videoExtensions, aspect, open: visible, canPreview, onPreview, onClose, onChange }: Props) {
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
      const path = await open({ title: `Choose ${end} media`,
        filters: [{ name: 'Images and videos', extensions: [...IMAGE_EXTENSIONS, ...videoExtensions] }] })
      if (!path) return
      const info = await invoke<Pick<Bookend, 'path' | 'name' | 'image'> & { duration: number }>('inspect_bookend', { path })
      onChange(target, end, {
        path: info.path, name: info.name, image: info.image,
        duration: info.image ? undefined : info.duration,
        transition: active[end]?.transition ?? 'cut',
      })
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }

  return <section id="bookends-menu" className="moment-panel editor-media-panel panel" hidden={!visible}
      aria-labelledby="bookends-title" onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
      }}>
      <header className="caption-style-heading">
        <h2 id="bookends-title">Intro / Outro</h2>
        <button type="button" className="icon-button compact" aria-label="Close intro and outro" onClick={onClose}><X size={16} /></button>
      </header>
      {visible && <div className="editor-media-fields">
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
              <option value="browse">Choose an image or video…</option>
            </select>
          </label>
          <label>Transition
            <select aria-label={`${label} transition`} value={transitionVideo?.transition ?? 'cut'}
              disabled={disabled || pending || !transitionVideo} onChange={event => {
                const transition = TRANSITIONS.find(item => item.value === event.target.value)?.value
                if (transition && transitionVideo) onChange(target, end, { ...transitionVideo, transition })
              }}>
              {TRANSITIONS.map(item => <option key={item.value} value={item.value}>{item.name}</option>)}
            </select>
          </label>
          {transitionVideo?.image && <ImagePlacement key={transitionVideo.path} image={transitionVideo}
            label={label} aspect={aspect} disabled={disabled || pending}
            onChange={image => onChange(target, end, image)} />}
        </div>
      })}
      <div className="bookend-actions">
        <button type="button" className="button outline small" disabled={!canPreview || disabled || pending}
          onClick={onPreview}><Play size={14} /> Preview full clip</button>
        <button type="button" className="button primary small" onClick={onClose}>Done</button>
      </div>
      {pending && <small role="status">Opening media…</small>}
      {error && <small role="alert">{error}</small>}
      </div>}
    </section>
}

function ImagePlacement({ image, label, aspect, disabled, onChange }: {
  image: Bookend; label: string; aspect: number; disabled: boolean; onChange: (image: Bookend) => void
}) {
  const [ready, setReady] = useState(false)
  const [imageAspect, setImageAspect] = useState(0)
  const [error, setError] = useState('')
  const drag = useRef<{ x: number; y: number; position: typeof CENTER } | null>(null)
  const path = image.path
  const position = image.position ?? CENTER
  const travel = imageAspect ? frameTravel(aspect, 1, imageAspect, 'fit') : { x: 0, y: 0 }
  const axis = Math.abs(travel.x) > 0.001 ? 'x' : Math.abs(travel.y) > 0.001 ? 'y' : null

  useEffect(() => {
    let current = true
    void invoke('inspect_bookend', { path }).then(() => {
      if (current) setReady(true)
    }).catch(error => {
      if (current) setError(String(error))
    })
    return () => { current = false }
  }, [path])

  return <div className="bookend-placement">
    <div className="bookend-image" style={{ aspectRatio: aspect, maxWidth: `${175 * aspect}px` }} data-draggable={Boolean(axis && !disabled)}
      onPointerDown={event => {
        if (disabled || !axis || event.button !== 0) return
        drag.current = { x: event.clientX, y: event.clientY, position }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const start = drag.current
        if (disabled || !start || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        const height = event.currentTarget.clientHeight
        if (!height) return
        onChange({ ...image, position: panPosition(start.position, travel, (event.clientX - start.x) / height, (event.clientY - start.y) / height) })
      }} onLostPointerCapture={() => { drag.current = null }}>
      {ready && <img src={convertFileSrc(path)} alt={`${label} placement preview`} draggable={false}
        style={{ objectPosition: `${position.x}% ${position.y}%` }} onLoad={event => {
          setImageAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)
        }} onError={() => setError('Could not display the image preview.')} />}
    </div>
    <div className="bookend-adjustments">
    <label>Image duration
      <select aria-label={`${label} image duration`} value={image.duration ?? 2} disabled={disabled}
        onChange={event => onChange({ ...image, duration: Number(event.target.value) })}>
        {[0.5, 1, 2, 3, 5, 8, 10].map(seconds => <option key={seconds} value={seconds}>{seconds} s</option>)}
      </select>
    </label>
    {axis && <label>{axis === 'x' ? 'Horizontal position' : 'Vertical position'}
      <input aria-label={`${label} position`} type="range" min={0} max={100} value={position[axis]} disabled={disabled}
        onChange={event => onChange({ ...image, position: { ...position, [axis]: event.target.valueAsNumber } })} />
    </label>}
    </div>
    {error && <small role="alert">{error}</small>}
  </div>
}
