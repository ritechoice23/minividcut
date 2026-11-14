import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export function ClipActions({ id, label, onClose, children }: {
  id: string; label: string; onClose: () => void; children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const popup = menu.current!
    const trigger = popup.previousElementSibling as HTMLButtonElement
    popup.showPopover()
    const anchor = trigger.getBoundingClientRect()
    const { width, height } = popup.getBoundingClientRect()
    const below = anchor.bottom + 5
    popup.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`
    popup.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 5)}px`
    popup.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const dismiss = (event: Event) => {
      if (event.type === 'scroll' && popup.contains(event.target as Node)) return
      if (popup.contains(document.activeElement)) trigger.focus({ preventScroll: true })
      onClose()
    }
    const toggled = (event: Event) => {
      if ((event as ToggleEvent).newState === 'closed') onClose()
    }
    popup.addEventListener('toggle', toggled)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      popup.removeEventListener('toggle', toggled)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [onClose])

  return <div ref={menu} popover="auto" className="clip-actions" id={id} role="group" aria-label={label}
    onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const trigger = event.currentTarget.previousElementSibling as HTMLButtonElement
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        trigger.focus()
        onClose()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        buttons[(index + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length]?.focus()
      }
    }}>{children}</div>
}
