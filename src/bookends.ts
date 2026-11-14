export const TRANSITIONS = [
  { value: 'cut', name: 'Cut' },
  { value: 'fade', name: 'Crossfade' },
  { value: 'slide', name: 'Slide left' },
] as const

export type Bookend = { path: string; name: string; transition: typeof TRANSITIONS[number]['value']; image?: boolean;
  duration?: number; position?: { x: number; y: number } }
export type Bookends = { intro?: Bookend | null; outro?: Bookend | null }

export function effectiveBookends(project: Bookends, clip?: Bookends): Bookends {
  return {
    intro: clip?.intro === undefined ? project.intro : clip.intro,
    outro: clip?.outro === undefined ? project.outro : clip.outro,
  }
}
