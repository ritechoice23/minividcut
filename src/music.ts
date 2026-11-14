export const MUSIC_LIBRARY = [
  { id: 'a-brand-new-wisdom', name: 'A Brand New Wisdom' },
  { id: 'just-saying-tho', name: 'Just Saying Tho' },
  { id: 'winter-dust', name: 'Winter Dust' },
  { id: 'swinging-sweet', name: 'Swinging Sweet' },
] as const

type LibraryTrack = typeof MUSIC_LIBRARY[number]['id']
export type MusicTrack = { kind: 'library'; id: LibraryTrack } | { kind: 'file'; path: string; name: string }
export type Music = { track: MusicTrack; volume: number }
export const DEFAULT_MUSIC_VOLUME = 15

export function effectiveMusic(project: Music | null, clip?: Music | null): Music | null {
  return clip === undefined ? project : clip
}

export function musicPosition(time: number, start: number, duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? Math.max(0, time - start) % duration : 0
}
