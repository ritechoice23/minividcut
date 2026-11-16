import type { Clip, Range } from './clip'

export type SequencePiece = { clipId: number; segment: Range; start: number; end: number }
export type SequenceMap = { pieces: SequencePiece[]; duration: number }

// Flattens clips into playback order. Removing a cut or a clip shortens this
// map, which is what makes the following material close up in the sequence.
export function buildSequenceMap(clips: readonly Clip[]): SequenceMap {
  let cursor = 0
  const pieces: SequencePiece[] = []
  for (const clip of clips) {
    const segments = clip.segments?.length ? clip.segments : [{ start: clip.start, end: clip.end }]
    for (const segment of segments) {
      const end = cursor + segment.end - segment.start
      pieces.push({ clipId: clip.id, segment, start: cursor, end })
      cursor = end
    }
  }
  return { pieces, duration: cursor }
}

export function sourceAtSequence(map: SequenceMap, time: number) {
  const piece = map.pieces.find(part => time >= part.start && time < part.end)
    ?? (time === map.duration ? map.pieces.at(-1) : undefined)
  if (!piece) return null
  const played = Math.max(0, Math.min(piece.segment.end - piece.segment.start, time - piece.start))
  return { clipId: piece.clipId, time: piece.segment.start + played }
}

export function sequenceAtSource(map: SequenceMap, time: number) {
  const piece = map.pieces.find(part => time >= part.segment.start && time < part.segment.end)
    ?? (time === map.duration ? map.pieces.at(-1) : undefined)
  return piece ? piece.start + Math.max(0, time - piece.segment.start) : null
}

export function clipSpans(map: SequenceMap, clips: readonly Clip[]) {
  return clips.map((clip, index) => {
    const parts = map.pieces.filter(piece => piece.clipId === clip.id)
    return { index, start: parts[0]?.start ?? 0, end: parts.at(-1)?.end ?? 0 }
  })
}

export function reorderClips(clips: readonly Clip[], from: number, to: number): Clip[] {
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return [...clips]
  const next = [...clips]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
