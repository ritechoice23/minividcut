// Search for the Ctrl+K command palette. Every word typed must appear in the
// command's label, group or keywords, so "cap all" finds "Caption all clips".
export type SearchableCommand = { id: string; label: string; group: string; keywords?: string }

export function matchesCommand(command: SearchableCommand, query: string) {
  const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word))
}

/** Matching commands, label-prefix matches first, original order otherwise. */
export function searchCommands<T extends SearchableCommand>(commands: readonly T[], query: string): T[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return [...commands]
  const matches = commands.filter(command => matchesCommand(command, trimmed))
  const prefix = (command: T) => command.label.toLowerCase().startsWith(trimmed) ? 0 : 1
  return matches.map((command, index) => ({ command, index }))
    .sort((a, b) => prefix(a.command) - prefix(b.command) || a.index - b.index)
    .map(({ command }) => command)
}

/** Groups in first-seen order, for rendering section headings. */
export function groupCommands<T extends SearchableCommand>(commands: readonly T[]) {
  const groups = new Map<string, T[]>()
  for (const command of commands) groups.set(command.group, [...groups.get(command.group) ?? [], command])
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}
