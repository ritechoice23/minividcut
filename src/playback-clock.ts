import { useSyncExternalStore } from 'react'

// Playback time changes several times a second. Keeping it outside React state
// stops those updates from re-rendering the entire editor; only the small
// components that display the playhead subscribe to it.
let current = 0
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = () => current

export const playbackClock = {
  get: snapshot,
  set(value: number) {
    if (!Number.isFinite(value) || Object.is(current, value)) return
    current = value
    listeners.forEach(listener => listener())
  },
}

export const usePlaybackTime = () => useSyncExternalStore(subscribe, snapshot, snapshot)
