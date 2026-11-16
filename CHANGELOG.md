# Changelog

## Unreleased

- Preview the full clip with intros, outros, transitions, captions and music composited live in the app — no render or temporary file until export.
- Keep playback responsive by isolating time updates, batching thumbnail generation, preparing caption artwork concurrently, and warming hardware encoders ahead of the first export.
- Verify the source video has not changed before exporting and release temporary asset access after a preview closes.

- Trim now removes the In–Out range from every saved clip at once. A cut leaves each clip as a single object with internal source segments instead of creating “Part 2” duplicates, and deleted sections close up on export.
- Edit clips directly on the timeline: select a clip, drag its edges, add a cut at the playhead with S, or remove it with Delete. Undo and redo are available from the timeline toolbar or Ctrl Z / Ctrl Shift Z.
- Clips with internal cuts preview their remaining parts back to back; the Sequence timeline view shows how the export order closes up after cuts.
- Switch the timeline between source time and a sequence view where cuts and deleted clips close the gaps, and drag clips there to reorder them. Snapping to nearby edit points can be toggled from the timeline toolbar.
- The playhead no longer oscillates after a seek, and scrubbing no longer auto-pans the viewport under your pointer.
- Ctrl + scroll the timeline to zoom in and out around the pointer in discrete steps. Shift + scroll or sideways trackpad swipes pan the viewport and drive the horizontal scrollbar; plain vertical scrolling leaves the timeline untouched so the filmstrip does not shift under the cursor. Wheel state is tracked in refs so rapid ticks do not make the view jump or the thumbnails churn.
- Cutting speech out of a clip also removes those caption cues, including word timings, and trimming a clip edge keeps its captions inside the new bounds.
- Music stays continuous across a clip's internal cuts instead of restarting at every segment.
- Undo and redo now cover caption edits, music and bookend changes, and shared caption styling.

- Keep the music panel focused on Kaino and local audio. Show progress and offer retry when catalog loading or a download fails.

- Audition any Kaino track from the music library before downloading it. Previews stream a short sample and play inline without blocking other actions.

- Refine the Kaino library into compact track rows with per-track progress, failures, and retry. Several tracks can download at once while search, preview, use, and removal stay available.

- Start a track at a chosen second and add an optional soft fade at each clip's edges, reflected in both previews and the exported audio.

- Show the auditioned sample as a waveform with a draggable start marker, so the in-point can be chosen by ear and by eye.

- Preview the full clip with its intro, outro, transitions, captions, and music. Playback places Play/Pause between the seek buttons and groups preview volume with mute.

- Search Kaino's CC0 music catalog and download individual tracks on demand. Reuse downloads offline or remove them from the music panel.

- Add background music to all clips or choose a different track for an individual clip. Preview the mix and adjust its volume. Tracks loop automatically through the end of each export.
- Download four optional CC0 tracks from the music library for offline use, or import a local audio file.
- Add custom intro and outro videos to all clips or to individual clips. Choose a cut, crossfade, or slide for each end.
- Use a still image for an intro or outro, choose its duration, and position it in a preview of the output frame.
- Open Background music and Intro / Outro beside the player. Browse Mixkit in your browser and import downloaded tracks.
- Duplicate clips from the clip actions menu.

## 0.5.0 — 2026-11-14

- Find transcript moments with Smart Split, preview suggestions on the timeline, and add the ones you want to export.
- Generate editable clip titles and captions on your device. Download and remove the speech and language models in Settings.
- Pan and zoom the timeline with thumbnails from the visible span. See where saved clips overlap.
- Edit caption timing and styling from the editor and apply a shared look across captioned clips.
- Resume a local draft or locate its original video after moving it. Cancel a batch export and keep the clips already saved.
- Export portrait or landscape clips with hardware encoding when supported and software fallback.
- Install on Windows x64 with FFmpeg and FFprobe included.
