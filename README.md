# MiniVidCut

A Windows desktop editor built with Tauri and React. Open or drop a video, drag the trim handles or type exact In and Out times, then add ranges to the clip list. **Split range** divides the current range at the playhead or at a fixed interval.

Choose **Landscape** (1920 × 1080) or **Portrait** (1080 × 1920). **Fill** crops around the center and **Fit** keeps the full picture with black borders as needed. Export saves a separate H.264 MP4 for each queued clip, or the active range when the list is empty. The first audio track is preserved when present. Existing output files are kept.

## Run on Windows

MiniVidCut uses the Windows WebView2 runtime and an FFmpeg 8.0 or later build with `ffmpeg`, `ffprobe`, and the `libx264` encoder available on PATH. [↗](https://ffmpeg.org/download.html) **FFmpeg downloads**

From source, install Node.js, Rust, and the Windows C++ build tools, then run:

```powershell
npm ci
npm run tauri -- dev
```

Build a Windows installer with `npm run tauri -- build`. Run the trim and export tests with `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.
