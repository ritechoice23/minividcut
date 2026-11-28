// App-wide preferences set on the Settings page. They are defaults for new
// work, never per-project data, so they live apart from the editing draft.
export type Format = 'landscape' | 'portrait'
export type Quality = 'compact' | 'compatible' | 'lossless'
/** Pieces an exported file name is built from, always joined in this order. */
export type FileNameParts = { video: boolean; number: boolean; title: boolean }

export const QUALITY_OPTIONS: { value: Quality; title: string; detail: string; tag?: string }[] = [
  { value: 'compact', title: 'Compact', detail: 'Smallest files. Best for phones, TikTok, Reels and Shorts.', tag: 'Recommended' },
  { value: 'compatible', title: 'Compatible', detail: 'Plays anywhere, even on old TVs, PCs and editing apps. Files are bigger.' },
  { value: 'lossless', title: 'Lossless', detail: 'Perfect copy with no quality loss. Very large files, only for more editing.' },
]

/** Assistants already installed on the PC that can pick clips instead of the on-device model. */
export type AgentId = 'claude' | 'codex' | 'opencode'
export type AiProvider = 'local' | AgentId
export type AiQuality = 'fast' | 'best'
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'opencode']

export type Preferences = {
  defaultFormat: Format
  defaultQuality: Quality
  fileNameParts: FileNameParts
  openFolderAfterExport: boolean
  autoCaption: boolean
  backgroundUpdates: boolean
  snapDefault: boolean
  /** What finds clips: the on-device model or an installed assistant. */
  aiProvider: AiProvider
  aiQuality: AiQuality
  /** Assistants the user agreed to send transcript text to. */
  aiConsent: Record<AgentId, boolean>
  /** Optional model for OpenCode, as provider/model. Empty uses its default. */
  aiModel: string
}

export const PREFERENCES_KEY = 'minividcut.preferences'

export const DEFAULT_PREFERENCES: Preferences = {
  defaultFormat: 'portrait',
  defaultQuality: 'compact',
  fileNameParts: { video: false, number: false, title: true },
  openFolderAfterExport: false,
  autoCaption: false,
  backgroundUpdates: true,
  snapDefault: true,
  aiProvider: 'local',
  aiQuality: 'fast',
  aiConsent: { claude: false, codex: false, opencode: false },
  aiModel: '',
}

const FORMATS: readonly Format[] = ['landscape', 'portrait']
const QUALITIES: readonly Quality[] = ['compact', 'compatible', 'lossless']
const PROVIDERS: readonly AiProvider[] = ['local', ...AGENT_IDS]
const AI_QUALITIES: readonly AiQuality[] = ['fast', 'best']
const MODEL_NAME = /^[A-Za-z0-9._:/#@+-]{1,120}$/

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback
const flag = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback

function parseFileNameParts(saved: Record<string, unknown>): FileNameParts {
  const base = DEFAULT_PREFERENCES.fileNameParts
  const parts = saved.fileNameParts
  if (parts && typeof parts === 'object') {
    const next = {
      video: flag((parts as Record<string, unknown>).video, false),
      number: flag((parts as Record<string, unknown>).number, false),
      title: flag((parts as Record<string, unknown>).title, false),
    }
    return next.video || next.number || next.title ? next : { ...base }
  }
  // Older versions saved a single choice.
  if (saved.fileNames === 'numbered') return { video: true, number: true, title: false }
  return { ...base }
}

function parseConsent(saved: Record<string, unknown>): Record<AgentId, boolean> {
  const consent = saved.aiConsent && typeof saved.aiConsent === 'object' ? saved.aiConsent as Record<string, unknown> : {}
  return { claude: consent.claude === true, codex: consent.codex === true, opencode: consent.opencode === true }
}

/** Reads saved preferences, keeping a default for anything missing or invalid. */
export function parsePreferences(raw: string | null): Preferences {
  let saved: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(raw ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed
  } catch { /* fall back to defaults */ }
  const base = DEFAULT_PREFERENCES
  const aiConsent = parseConsent(saved)
  const aiProvider = pick(saved.aiProvider, PROVIDERS, base.aiProvider)
  return {
    // An assistant is only used after the user agreed to send it transcript text.
    aiProvider: aiProvider !== 'local' && !aiConsent[aiProvider] ? 'local' : aiProvider,
    aiQuality: pick(saved.aiQuality, AI_QUALITIES, base.aiQuality),
    aiConsent,
    aiModel: typeof saved.aiModel === 'string' && MODEL_NAME.test(saved.aiModel.trim()) ? saved.aiModel.trim() : base.aiModel,
    defaultFormat: pick(saved.defaultFormat, FORMATS, base.defaultFormat),
    defaultQuality: pick(saved.defaultQuality, QUALITIES, base.defaultQuality),
    fileNameParts: parseFileNameParts(saved),
    openFolderAfterExport: flag(saved.openFolderAfterExport, base.openFolderAfterExport),
    autoCaption: flag(saved.autoCaption, base.autoCaption),
    backgroundUpdates: flag(saved.backgroundUpdates, base.backgroundUpdates),
    snapDefault: flag(saved.snapDefault, base.snapDefault),
  }
}

export function readPreferences(storage: Pick<Storage, 'getItem'>): Preferences {
  try {
    return parsePreferences(storage.getItem(PREFERENCES_KEY))
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function writePreferences(storage: Pick<Storage, 'setItem'>, preferences: Preferences) {
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
    return true
  } catch {
    return false
  }
}

/**
 * The file name sent to export, e.g. "Moon Tour - 01 - Lava plains". Returns
 * undefined when nothing applies so the exporter falls back to its default name.
 */
export function exportFileName(
  parts: FileNameParts, clip: { title?: string; number: number; video: string },
) {
  const pieces = [
    parts.video ? clip.video.trim() : '',
    parts.number ? String(clip.number).padStart(2, '0') : '',
    parts.title ? clip.title?.trim() ?? '' : '',
  ].filter(Boolean)
  return pieces.length ? pieces.join(' - ') : undefined
}

/** A short example shown next to the setting. */
export function fileNameExample(parts: FileNameParts) {
  return exportFileName(parts, { title: 'Lava plains', number: 1, video: 'Moon Tour' }) ?? 'Moon Tour - Clip 01'
}
