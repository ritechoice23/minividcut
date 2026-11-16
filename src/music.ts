export type KainoCollection = 'music' | 'sfx'
// The bundled library is no longer shipped; keep the kind so older drafts
// still load and can be switched to a Kaino track or local file.
export type MusicTrack = { kind: 'library'; id: string }
  | { kind: 'kaino'; id: string; name: string; collection?: KainoCollection }
  | { kind: 'file'; path: string; name: string }
export const kainoKey = (id: string, collection: KainoCollection = 'music') =>
  `kaino:${collection === 'sfx' ? 'sfx:' : ''}${id}`
// `start` is seconds into the track; `fade` softens the clip's first and last
// moments. Both are optional so drafts saved before they existed still load.
export type Music = { track: MusicTrack; volume: number; start?: number; fade?: boolean }
export const DEFAULT_MUSIC_VOLUME = 15
export const DEFAULT_FADE_SECONDS = 0.8

export function effectiveMusic(project: Music | null, clip?: Music | null): Music | null {
  return clip === undefined ? project : clip
}

export function musicPosition(time: number, start: number, duration: number, offset = 0): number {
  const within = Math.max(0, time - start)
  const from = Math.max(0, offset)
  return Number.isFinite(duration) && duration > 0 ? (within + from) % duration : 0
}

/** Gain envelope for the clip's fade-in and fade-out, shared by both previews. */
export function musicGain(time: number, start: number, end: number, fade = false): number {
  if (!fade) return 1
  const length = end - start
  if (!(length > 0)) return 1
  const seconds = Math.min(DEFAULT_FADE_SECONDS, length / 3)
  return Math.max(0, Math.min(1, (time - start) / seconds, (end - time) / seconds))
}
