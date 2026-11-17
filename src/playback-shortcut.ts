// Decision logic for the global Space play/pause shortcut. Kept separate from
// the React component so the focus and overlay rules can be tested directly.

type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey'>
type Target = { closest(selector: string): unknown } | null
type ShortcutState = { hasSource: boolean; settingsOpen: boolean; shortcutsOpen: boolean }

export function isTextEditing(target: Target): boolean {
  if (!target) return false
  if (target.closest('textarea, [contenteditable="true"], [contenteditable=""]')) return true
  const input = target.closest('input')
  if (!input || typeof input !== 'object') return false
  const type = String((input as { type?: unknown }).type ?? '').toLowerCase()
  return !['range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(type)
}

export function isPlaybackShortcut(
  event: KeyEvent,
  state: ShortcutState,
  target: Target,
  querySelector: (selector: string) => unknown,
): boolean {
  if ((event.key !== ' ' && event.code !== 'Space') || event.isComposing ||
    event.ctrlKey || event.metaKey || event.altKey ||
    !state.hasSource || state.settingsOpen || state.shortcutsOpen) return false
  // Buttons, tabs, sliders and links must not swallow Space. Only text entry
  // and open overlays keep its native behaviour.
  if (isTextEditing(target) || querySelector('[popover]:popover-open')) return false
  return true
}
