import type { CaptionStyle } from './captions'

// One-click caption looks for the Captions panel. Each look is a combination
// of the existing detailed settings, which stay editable under "More options".
export type CaptionLook = {
  id: string
  label: string
  style: Pick<CaptionStyle, 'preset' | 'mode' | 'case'> & Partial<Pick<CaptionStyle, 'font'>>
}

export const CAPTION_LOOKS: readonly CaptionLook[] = [
  { id: 'classic', label: 'Classic', style: { preset: 'classic', mode: 'phrase', case: 'original' } },
  { id: 'highlight', label: 'Highlight', style: { preset: 'classic', mode: 'highlight', case: 'original' } },
  { id: 'boxed', label: 'Boxed', style: { preset: 'boxed', mode: 'phrase', case: 'original' } },
  { id: 'word', label: 'Word by word', style: { preset: 'classic', mode: 'word', case: 'original' } },
  { id: 'bold', label: 'Bold', style: { preset: 'classic', mode: 'highlight', case: 'upper', font: 'Impact' } },
  { id: 'serif', label: 'Serif', style: { preset: 'serif', mode: 'phrase', case: 'original', font: 'Georgia' } },
]

export function applyLook(style: CaptionStyle, look: CaptionLook): CaptionStyle {
  return { ...style, ...look.style }
}

/** The look matching a style, or undefined when it was customized by hand. */
export function activeLook(style: CaptionStyle): CaptionLook | undefined {
  const mode = style.mode ?? 'phrase'
  const letterCase = style.case ?? 'original'
  return CAPTION_LOOKS.find(look => look.style.preset === style.preset && look.style.mode === mode
    && look.style.case === letterCase && (!look.style.font || look.style.font === style.font))
}
