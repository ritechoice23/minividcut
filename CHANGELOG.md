# Changelog

## Unreleased

## 1.0.0 — 2026-11-17

- **Delete a range from the whole video.** Mark In and Out, press Trim, and the footage closes up in both the preview and a single exported file — like a ripple delete in a desktop editor. Drag clip edges to trim, snap to nearby edit points, undo and redo, and zoom or pan the timeline. Playback now starts from the position you clicked instead of jumping back to the beginning.
- **Preview the finished cut.** Intros, outros, transitions, captions and music are composited live in the player. The full intro and outro play at the edges, the timeline playhead follows the composite, and bookend images render reliably. Space always plays or pauses the active preview, even when a control has focus.
- **Add background music.** Choose one track for the whole project or a different one per clip, import a local audio file, pick where the track starts, set its volume, and add a soft fade at each clip's edges. The mix loops through the export and stays continuous across cuts.
- **Explore the Kaino library.** Search CC0 music and sound effects, audition a sample before downloading, choose the in-point on a waveform, download several tracks at once with cancel and retry, and reuse downloads offline.
- **Edit captions with confidence.** Adjust words and timing, apply a shared style, and keep cues aligned after a range is removed.
- **Export what you see.** Portrait or landscape output, hardware encoding with a software fallback, captions, music, and bookends in one file — even after a ripple delete.
- **Faster and steadier.** Playback stays responsive while editing, thumbnails and caption artwork are prepared in the background, catalog failures can be retried, and several preview and asset-loading issues are fixed.

## 0.5.0 — 2026-11-14

- Find transcript moments with Smart Split, preview suggestions on the timeline, and add the ones you want to export.
- Generate editable clip titles and captions on your device. Download and remove the speech and language models in Settings.
- Pan and zoom the timeline with thumbnails from the visible span. See where saved clips overlap.
- Edit caption timing and styling from the editor and apply a shared look across captioned clips.
- Resume a local draft or locate your original video after moving it. Cancel a batch export and keep the clips already saved.
- Export portrait or landscape clips with hardware encoding when supported and software fallback.
- Install on Windows x64 with FFmpeg and FFprobe included.
