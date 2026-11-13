# MiniVidCut

![MiniVidCut banner with a lime-green clip selection on a dark timeline](docs/thumbnail.png)

**The simplest, smartest way to turn long videos into short clips.**

A lightweight Windows app for precise trimming and batch export. Built by [↗](https://github.com/ritechoice23) **Daramola Babatunde** (@ritechoice23).

Open or drop a video, drag the trim handles, type exact In and Out times, or use the bracket buttons to set either marker at the playhead. If a marker crosses the other, the other marker moves just far enough to keep a usable range where the video has room. **Split range** divides the current range at the playhead or at a fixed interval. Choose **Mark only** to review sections and add them individually, or **Split & add** to queue the whole split.

Clips show a thumbnail from their first frame. Double-click a clip or press **F2** to rename it. Custom titles become MP4 filenames, and unnamed clips use the original video name and clip number.

Choose **Landscape** (1920 × 1080) or **Portrait** (1080 × 1920). **Fill** crops the image and **Fit** keeps the full picture with black borders as needed. Drag the picture or use the position slider to adjust the framing for the entire export batch. **Center** resets the position.

Export saves a separate MP4 for each queued clip, or the active range when the list is empty. Up to five clips export at once depending on available CPU cores. The Clips panel shows progress for the whole batch and each clip, then displays saved file sizes. Existing output files are kept.

**Compact** uses H.265 for smaller files at high visual quality. **Compatible** uses H.264 for broader playback support. **Lossless video** preserves the rendered video frames exactly and can produce much larger files. All modes encode the first audio track as AAC when present.

## Built with

React, TypeScript, and Vite for the interface, Tauri and Rust for the desktop app, and FFmpeg for video processing.

## Run on Windows

MiniVidCut uses the Windows WebView2 runtime and an FFmpeg 8.0 or later build with `ffmpeg` and `ffprobe` available on PATH. The Compact preset requires `libx265`, and Compatible and Lossless video require `libx264`. [↗](https://ffmpeg.org/download.html) **FFmpeg downloads**

From source, install Node.js, Rust, and the Windows C++ build tools, then run:

```powershell
npm ci
npm run tauri -- dev
```

Build a Windows installer with `npm run tauri -- build`. Run the trim and export tests with `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.

## Contributing

Bug reports, documentation fixes, and small improvements are welcome. For bugs, open an issue with the steps to reproduce and your Windows and FFmpeg versions. To contribute a change, fork the repo, run the relevant tests above, and open a pull request describing what changed and how you tested it.
