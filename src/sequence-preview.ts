import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Range } from './clip'
import type { Bookends } from './bookends'
import type { CaptionTrack } from './captions'
import { captionSlice } from './captions'
import type { FramePosition, Framing } from './framing'
import type { Music } from './music'
import { prepareCaptionOverlay } from './caption-export'

type Sequence = {
  path: string
  duration: number
  range: Range
  captions?: CaptionTrack
  music: Music | null
  bookends: Bookends
  options: { format: 'landscape' | 'portrait'; framing: Framing; position: FramePosition }
}

export function useSequencePreview(key: string, onError: (message: string) => void) {
  const [cached, setCached] = useState<{ key: string; path: string } | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const request = useRef<{ id: string; key: string; encoding: boolean } | null>(null)
  const player = useRef<HTMLVideoElement>(null)
  const playingKey = useRef<string | null>(null)

  const stop = useCallback(() => {
    const active = request.current
    request.current = null
    if (active?.encoding) void invoke('cancel_sequence_preview', { request: active.id }).catch(() => {})
    player.current?.pause()
    playingKey.current = null
    setPreparing(false)
    setShown(null)
  }, [])

  useEffect(() => {
    if ((request.current && request.current.key !== key) ||
        (playingKey.current && playingKey.current !== key)) stop()
  }, [key, stop])
  useEffect(() => stop, [stop])

  async function play(sequence: Sequence, sequenceKey = key) {
    stop()
    if (cached?.key === sequenceKey) {
      playingKey.current = sequenceKey
      setShown(cached.path)
      return
    }
    const job = { id: crypto.randomUUID(), key: sequenceKey, encoding: false }
    request.current = job
    setPreparing(true)
    setCached(null)
    let captionOverlay: string | undefined
    try {
      const captions = captionSlice(sequence.captions, sequence.range, true)
      if (captions) {
        captionOverlay = await prepareCaptionOverlay(captions, sequence.options.format,
          sequence.range.end - sequence.range.start, () => request.current !== job)
      }
      if (request.current !== job) return
      job.encoding = true
      const path = await invoke<string>('prepare_sequence_preview', {
        request: job.id, path: sequence.path, duration: sequence.duration,
        options: { ...sequence.options, quality: 'compatible' },
        clip: { start: sequence.range.start, end: sequence.range.end,
          captionOverlay, music: sequence.music, bookends: sequence.bookends },
      })
      if (request.current !== job) return
      setCached({ key: sequenceKey, path })
      playingKey.current = sequenceKey
      setShown(path)
    } catch (error) {
      if (request.current === job) onError(`Could not prepare clip preview. ${String(error)}`)
    } finally {
      if (captionOverlay) void invoke('discard_caption_overlays', { ids: [captionOverlay] }).catch(() => {})
      if (request.current === job) {
        request.current = null
        setPreparing(false)
      }
    }
  }

  return { path: shown, preparing, player, play, stop }
}
