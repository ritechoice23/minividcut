import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { groupCommands, searchCommands } from './command-search'

export type PaletteCommand = {
  id: string
  label: string
  group: string
  keywords?: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  run: () => void
}

// Ctrl+K: every action in the app, searchable. Disabled commands stay listed
// so the user learns where a feature lives even before it applies.
export function CommandPalette({ open, commands, onClose }: {
  open: boolean; commands: PaletteCommand[]; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const results = useMemo(() => searchCommands(commands, query), [commands, query])
  const runnable = results.filter(command => !command.disabled)
  const current = runnable[Math.min(active, runnable.length - 1)]

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    requestAnimationFrame(() => input.current?.focus())
  }, [open])
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query])

  if (!open) return null
  const run = (command?: PaletteCommand) => {
    if (!command || command.disabled) return
    onClose()
    // Let the palette close first so a command that opens a dialog gets focus.
    requestAnimationFrame(() => command.run())
  }

  return <div className="palette-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="palette" role="dialog" aria-modal="true" aria-label="All actions"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); onClose() }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!runnable.length) return
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive(index => (Math.min(index, runnable.length - 1) + step + runnable.length) % runnable.length)
        } else if (event.key === 'Enter') { event.preventDefault(); run(current) }
      }}>
      <label className="palette-search">
        <Search size={18} aria-hidden="true" />
        <input ref={input} value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Type a command…" aria-label="Search actions" spellCheck={false}
          role="combobox" aria-expanded="true" aria-controls="palette-results"
          aria-activedescendant={current ? `palette-${current.id}` : undefined} />
      </label>
      <div className="palette-results" id="palette-results" role="listbox" ref={list}>
        {groupCommands(results).map(({ group, items }) => <div className="palette-group" key={group} role="group" aria-label={group}>
          <h4>{group}</h4>
          {items.map(command => <button type="button" key={command.id} id={`palette-${command.id}`} role="option"
            className="palette-item" aria-selected={command === current} data-active={command === current}
            disabled={command.disabled} onPointerMove={() => {
              const index = runnable.indexOf(command)
              if (index >= 0 && index !== active) setActive(index)
            }} onClick={() => run(command)}>
            <span className="palette-icon" aria-hidden="true">{command.icon}</span>
            <span className="palette-label">{command.label}</span>
            {command.shortcut && <kbd>{command.shortcut}</kbd>}
          </button>)}
        </div>)}
        {!results.length && <p className="palette-empty">No action matches “{query}”.</p>}
      </div>
      <footer className="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>
        <span className="palette-hint">Every action in MiniVidCut is searchable here</span>
      </footer>
    </section>
  </div>
}
