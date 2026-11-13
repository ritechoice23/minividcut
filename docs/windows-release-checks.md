# Windows release verification

Run these checks on a fresh Windows x64 machine using the exact installer
intended for release. Record the installer SHA-256, Windows version, GPU,
driver version, source media, and results.

- Install without system FFmpeg or developer tools. Check the first launch
  and WebView2 installation if the runtime is missing.
- Open a long phone recording that needs a compatibility preview. Time the
  first playable frame, scrub near the end, then switch files while a preview
  is building and check that the old job stops.
- Create named clips, edit captions and framing, close and reopen, and resume
  the draft. Repeat after moving the source file and locating it again.
- Generate captions with a fresh profile, then disconnect the network and
  generate captions again. Export a portrait clip with those captions.
- Export ten clips in each orientation. Record time to first saved clip,
  total duration, and the encoder reported for each clip. Repeat on a
  CPU-only machine and on supported GPU hardware.
- Cancel after a clip is saved. Play the saved files and check for leftover
  temporary files. Retry into a nearly full test volume and check that
  failed clips leave no partial files.
- Before distributing the installer, make the complete corresponding
  source for the exact bundled FFmpeg build available alongside it. The
  third-party notice identifies the upstream revision and build scripts.
