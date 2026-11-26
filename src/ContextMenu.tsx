import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type MenuItem =
  | { label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | 'separator'

export type MenuState = { x: number; y: number; title?: string; items: MenuItem[] } | null

/**
 * A right-click menu placed at the pointer and kept inside the window.
 * Arrow keys move between items, Enter runs one, and Escape, a click
 * elsewhere, scrolling or switching windows closes it.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    const element = box.current
    if (!menu || !element) return
    const { width, height } = element.getBoundingClientRect()
    setPlace({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - width - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - height - 6)),
    })
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      if (event.type === 'pointerdown' && box.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('wheel', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, onClose])

  if (!menu) return null
  const move = (step: number) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(current + step + buttons.length) % buttons.length].focus()
  }
  return <div ref={box} className="context-menu" role="menu" aria-label={menu.title ?? 'Actions'}
    style={{ left: place.left, top: place.top }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      else if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
      else if (event.key === 'Tab') { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
    }}>
    {menu.title && <div className="context-menu-title">{menu.title}</div>}
    {menu.items.map((item, index) => item === 'separator'
      ? <div key={`separator-${index}`} className="context-menu-separator" role="separator" />
      : <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
        className={item.danger ? 'danger' : undefined}
        onClick={() => { onClose(); item.run() }}>
        <span className="context-menu-icon" aria-hidden="true">{item.icon}</span>
        <span className="context-menu-label">{item.label}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>)}
  </div>
}
