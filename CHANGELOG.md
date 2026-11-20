# Changelog

## Unreleased

- **Windows signing is ready to configure.** Manual workflows can sign and verify an installer with the free SignPath Foundation certificate for open-source projects, or with your own OV/EV certificate from repository secrets, and replace the installer on an existing release. See `docs/windows-code-signing.md`. SignPath approval / a certificate is still required; releases up to 1.2.0 remain unsigned.

## 1.2.0 — 2026-11-19

- **Layer as much text as you need.** A clip can now hold up to 50 separate text blocks, each with its own words, size, font, colour and position. Pick a block in the Text panel to edit it, drag just that block on the preview, or remove it without touching the others.
- **Much longer messages.** One text block now accepts up to 4,000 characters instead of 160, and automatically scales to fit the frame so nothing gets clipped.
- **Old text carries forward.** Text saved by 1.1.0 is migrated into the new block list when a draft opens.

## 1.1.0 — 2026-11-19

- **Write on the picture.** Open the new Text panel to add a text overlay to a chosen clip (or the current range). Type your words, change the size, font and colour, then drag the text anywhere on the preview — or fine-tune its position with sliders. The text is drawn with the same artwork engine as captions, so what you see in the player is what gets burned into the exported video, in both landscape and portrait.
- **Keep and mix your own music.** Import a local audio track into a personal library that survives moving or deleting the original file, then set its volume, start point and clip-edge fades. Mix changes apply to the running preview immediately and stay with the track.
- **Clearer caption artwork preparation.** Static text and timed captions share one cropped overlay, so adding a title does not add a second encode pass.

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
