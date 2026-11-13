export type Framing = 'fill' | 'fit'
export type FramePosition = { x: number; y: number }
export const CENTER: FramePosition = { x: 50, y: 50 }

export function frameTravel(width: number, height: number, aspect: number, framing: Framing): FramePosition {
  const scale = (framing === 'fill' ? Math.max : Math.min)(width / aspect, height)
  return { x: width - scale * aspect, y: height - scale }
}

export function panPosition(start: FramePosition, travel: FramePosition, dx: number, dy: number): FramePosition {
  const move = (position: number, distance: number, available: number) =>
    Math.abs(available) < 0.01 ? position : Math.round(Math.max(0, Math.min(100, position + 100 * distance / available)))
  return { x: move(start.x, dx, travel.x), y: move(start.y, dy, travel.y) }
}
