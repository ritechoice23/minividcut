import type { Range } from './clip'
import type { Bookends } from './bookends'
import type { Framing, FramePosition } from './framing'
import type { Music } from './music'
import type { CaptionTrack } from './captions'

// Mirrors src-tauri/src/bookends.rs so browser previews and FFmpeg exports use
// the same segment lengths, overlap caps and transition positions.
export const FPS = 30
export const MAX_TRANSITION_FRAMES = 15
type Transition = 'cut' | 'fade' | 'slide'
export type Format = 'landscape' | 'portrait'

export type BookendMedia = { image: boolean; duration: number }

export type PlanLayer = {
  path: string
  image: boolean
  transition: Transition
  position?: FramePosition
  length: number
  start: number
  overlap: number
}

export type MainSegment = { start: number; sourceStart: number; length: number }

export type CompositionPlan = {
  total: number
  main: {
    path: string; sourceStart: number; length: number; start: number
    segments: MainSegment[]
    framing: Framing; position: FramePosition; format: Format
  }
  intro: PlanLayer | null
  outro: PlanLayer | null
  captions?: CaptionTrack
  music: Music | null
  musicPath: string
  muted: boolean
}

const frames = (seconds: number) => Math.max(1, Math.round(seconds * FPS))
const seconds = (count: number) => count / FPS
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value))

export function overlapFrames(transition: Transition, first: number, second: number) {
  return transition === 'cut' ? 0 : Math.min(MAX_TRANSITION_FRAMES, Math.floor(first / 2), Math.floor(second / 2))
}

export function buildCompositionPlan({
  path, range, segments, bookends, media, format, framing, position, captions, music, musicPath, muted,
}: {
  path: string
  range: Range
  segments?: Range[]
  bookends: Bookends
  media: Record<string, BookendMedia>
  format: Format
  framing: Framing
  position: FramePosition
  captions?: CaptionTrack
  music: Music | null
  musicPath: string
  muted: boolean
}): CompositionPlan {
  const sourceSegments = (segments?.length ? segments : [range])
    .map(segment => ({ start: segment.start, end: segment.end }))
    .sort((first, second) => first.start - second.start)
  const mainLength = Math.max(0.05, sourceSegments.reduce((total, segment) => total + segment.end - segment.start, 0))
  const mainFrames = frames(mainLength)
  const introInfo = bookends.intro
  const outroInfo = bookends.outro
  const introMedia = introInfo ? media[introInfo.path] : undefined
  const outroMedia = outroInfo ? media[outroInfo.path] : undefined

  const introLength = introInfo ? (introMedia?.image ? (introInfo.duration ?? 2) : (introMedia?.duration ?? 0)) : 0
  const outroLength = outroInfo ? (outroMedia?.image ? (outroInfo.duration ?? 2) : (outroMedia?.duration ?? 0)) : 0
  const introFrames = introInfo ? frames(introLength) : 0
  const outroFrames = outroInfo ? frames(outroLength) : 0
  const firstOverlap = introInfo ? overlapFrames(introInfo.transition, introFrames, mainFrames) : 0
  const afterIntro = introInfo ? introFrames + mainFrames - firstOverlap : mainFrames
  const lastOverlap = outroInfo ? overlapFrames(outroInfo.transition, afterIntro, outroFrames) : 0
  const total = seconds(afterIntro + (outroInfo ? outroFrames - lastOverlap : 0))
  const mainStart = introInfo ? seconds(introFrames - firstOverlap) : 0
  const outroStart = seconds(afterIntro - lastOverlap)
  const mainSegments: MainSegment[] = []
  let segmentStart = mainStart
  for (const segment of sourceSegments) {
    const length = segment.end - segment.start
    mainSegments.push({ start: segmentStart, sourceStart: segment.start, length })
    segmentStart += length
  }

  return {
    total,
    main: {
      path, sourceStart: sourceSegments[0].start, length: mainLength, start: mainStart,
      segments: mainSegments, framing, position, format,
    },
    intro: introInfo && introMedia ? {
      path: introInfo.path, image: introMedia.image, transition: introInfo.transition,
      position: introInfo.position, length: introLength, start: 0, overlap: seconds(firstOverlap),
    } : null,
    outro: outroInfo && outroMedia ? {
      path: outroInfo.path, image: outroMedia.image, transition: outroInfo.transition,
      position: outroInfo.position, length: outroLength, start: outroStart, overlap: seconds(lastOverlap),
    } : null,
    captions, music, musicPath, muted,
  }
}

/** Inverse of the main-layer mapping: where a source-time position plays. */
export function sourceToPlanTime(plan: CompositionPlan, sourceTime: number) {
  const segments = plan.main.segments?.length ? plan.main.segments
    : [{ start: plan.main.start, sourceStart: plan.main.sourceStart, length: plan.main.length }]
  const first = segments[0]
  const last = segments[segments.length - 1]
  if (sourceTime <= first.sourceStart) return Math.max(0, Math.min(plan.total, sourceTime))
  for (const segment of segments) {
    if (sourceTime >= segment.sourceStart && sourceTime <= segment.sourceStart + segment.length) {
      return segment.start + (sourceTime - segment.sourceStart)
    }
  }
  return Math.min(
    plan.total,
    last.start + last.length + Math.max(0, sourceTime - (last.sourceStart + last.length)),
  )
}

export type LayerState = { active: boolean; local: number; alpha: number; slide: number }

export function layerState(layer: PlanLayer | 'main', plan: CompositionPlan, time: number): LayerState {
  if (layer === 'main') {
    const start = plan.main.start
    const end = start + plan.main.length
    if (time < start || time >= end) return { active: false, local: 0, alpha: 0, slide: 0 }
    const intro = plan.intro
    const outro = plan.outro
    const fadeIn = intro?.overlap ? clamp((time - start) / intro.overlap) : 1
    const fadeOut = outro?.overlap ? clamp((end - time) / outro.overlap) : 1
    const slideIn = intro?.transition === 'slide' && intro.overlap ? -100 * (1 - clamp((time - start) / intro.overlap)) : 0
    const slideOut = outro?.transition === 'slide' && outro.overlap ? -100 * (1 - clamp((end - time) / outro.overlap)) : 0
    const segment = plan.main.segments.find(part => time >= part.start && time < part.start + part.length)
      ?? plan.main.segments[plan.main.segments.length - 1]
    return {
      active: true,
      local: segment ? segment.sourceStart + clamp(time - segment.start, 0, segment.length) : plan.main.sourceStart,
      alpha: fadeIn * fadeOut,
      slide: slideIn + slideOut,
    }
  }
  const end = layer.start + layer.length
  if (time < layer.start || time >= end) return { active: false, local: 0, alpha: 0, slide: 0 }
  const alpha = layer.overlap ? clamp((end - time) / layer.overlap) : 1
  const slide = layer.transition === 'slide' && layer.overlap
    ? -100 * (1 - clamp((end - time) / layer.overlap)) : 0
  return { active: true, local: clamp(time - layer.start, 0, layer.length), alpha, slide }
}

export function outroLayerState(plan: CompositionPlan, time: number): LayerState {
  const layer = plan.outro
  if (!layer) return { active: false, local: 0, alpha: 0, slide: 0 }
  const end = layer.start + layer.length
  if (time < layer.start || time >= end) return { active: false, local: 0, alpha: 0, slide: 0 }
  const alpha = layer.overlap ? clamp((time - layer.start) / layer.overlap) : 1
  const slide = layer.transition === 'slide' && layer.overlap
    ? 100 * (1 - clamp((time - layer.start) / layer.overlap)) : 0
  return { active: true, local: clamp(time - layer.start, 0, layer.length), alpha, slide }
}
