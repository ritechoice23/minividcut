import { create } from 'zustand'

// High-frequency playback state lives outside the React tree so a time tick
// only re-renders the few components that actually display time. Components
// subscribe with selectors; event handlers read getState() without subscribing.
type EditorState = {
  time: number
  sequenceTime: number
  sequenceDuration: number
  previewSourceTime: number
  sequenceActive: boolean
  sequencePlaying: boolean
  setTime: (time: number) => void
  setSequenceTime: (time: number, duration: number, sourceTime: number) => void
  setSequencePlaying: (playing: boolean) => void
  setSequenceActive: (active: boolean) => void
}

export const useEditor = create<EditorState>((set) => ({
  time: 0,
  sequenceTime: 0,
  sequenceDuration: 0,
  previewSourceTime: 0,
  sequenceActive: false,
  sequencePlaying: false,
  setTime: (time) => set((state) => state.time === time ? state : { time }),
  setSequenceTime: (time, sequenceDuration, sourceTime) => set({
    sequenceTime: time, sequenceDuration, previewSourceTime: sourceTime,
  }),
  setSequencePlaying: (sequencePlaying) => set({ sequencePlaying }),
  setSequenceActive: (sequenceActive) => set({ sequenceActive }),
}))

export const playbackClock = {
  get: () => useEditor.getState().time,
  set: (value: number) => {
    if (Number.isFinite(value)) useEditor.getState().setTime(value)
  },
}

export const usePlaybackTime = () => useEditor((state) => state.time)

// The timeline is drawn in source time. During a full-clip preview the clock is
// driven by composite time, so the playhead must follow the mapped source time
// instead of the source clock, which stops advancing while the preview runs.
export const selectTimelineTime = (state: EditorState) =>
  state.sequenceActive ? state.previewSourceTime : state.time

// During a full-clip preview the transport and trim controls act on composite
// time, not on the source video's playhead.
export function activeTime() {
  const state = useEditor.getState()
  return state.sequenceActive ? state.previewSourceTime : state.time
}
