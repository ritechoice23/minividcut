import { memo, useLayoutEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import { Move } from 'lucide-react'
import { captionDimensions } from './caption-artwork'
import { drawText, textActive, textLayout } from './text-overlay'
import type { TextOverlay } from './text-overlay'

export type TextOverlayPreviewProps = {
  overlays: TextOverlay[]
  format: 'landscape' | 'portrait'
  selectedId?: string | null
  draggable?: boolean
  onPosition?: (id: string, x: number, y: number) => void
  className?: string
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const TextOverlayPreview = memo(function TextOverlayPreview({
  overlays, format, selectedId, draggable = false, onPosition, className,
}: TextOverlayPreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const canDrag = draggable && Boolean(onPosition) && Boolean(selectedId)
  const selected = selectedId ? overlays.find(overlay => overlay.id === selectedId) ?? null : null

  useLayoutEffect(() => {
    const surface = canvas.current
    if (!surface) return
    const context = surface.getContext('2d')
    if (!context) return
    const { width, height } = captionDimensions(format)
    surface.width = width
    surface.height = height
    context.clearRect(0, 0, width, height)
    for (const overlay of overlays) {
      if (!textActive(overlay)) continue
      const layout = textLayout(context, overlay, format)
      if (!layout) continue
      drawText(context, layout, overlay)
    }
  }, [overlays, format])

  const report = (event: PointerEvent<HTMLDivElement>) => {
    if (!onPosition || !selectedId) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1)
    onPosition(selectedId, x, y)
  }

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // The preview also handles panning; a text drag must not reach it or the
    // canvas steals pointer capture and the text stops following the pointer.
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    report(event)
  }

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.stopPropagation()
    report(event)
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.stopPropagation()
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      className={`text-overlay-preview ${canDrag ? 'draggable' : ''} ${className ?? ''}`}
      onPointerDown={canDrag ? startDrag : undefined}
      onPointerMove={canDrag ? moveDrag : undefined}
      onPointerUp={canDrag ? endDrag : undefined}
      onLostPointerCapture={canDrag ? endDrag : undefined}
    >
      <canvas ref={canvas} className="caption-artwork" aria-hidden="true" />
      {canDrag && selected && (
        <span
          className="text-position-handle"
          aria-hidden="true"
          style={{
            left: `${selected.x * 100}%`,
            top: `${selected.y * 100}%`,
            transform: 'translate(-50%, -50%)',
          }}
        ><Move size={14} /></span>
      )}
    </div>
  )
})
