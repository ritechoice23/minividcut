# MiniVidCut

![MiniVidCut banner with a lime-green clip selection on a dark timeline](docs/thumbnail.png)

**The simplest, smartest way to turn long videos into short clips.**

A lightweight Windows app for precise trimming and batch export. Built by [↗](https://github.com/ritechoice23) **Daramola Babatunde** (@ritechoice23).

Cut the best moments from any long video and reframe them for portrait or landscape.
Add automatic captions on your device and export all your clips in one batch.

## Built with

React, TypeScript, and Vite for the interface, Tauri and Rust for the desktop app, and FFmpeg for video processing.

## Run on Windows

MiniVidCut uses the Windows WebView2 runtime and an FFmpeg 8.0 or later build with `ffmpeg` and `ffprobe` available on PATH. The Compact preset requires `libx265`, and Compatible and Lossless video require `libx264`. [↗](https://ffmpeg.org/download.html) **FFmpeg downloads**

From source, install Node.js, Rust, and the Windows C++ build tools. Make sure CMake is on PATH, then run:

```powershell
npm ci
npm run tauri -- dev
```

Build a Windows installer with `npm run tauri -- build`. Run the trim and export tests with `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.

## Contributing

Bug reports, documentation fixes, and small improvements are welcome. For bugs, open an issue with the steps to reproduce and your Windows and FFmpeg versions. To contribute a change, fork the repo, run the relevant tests above, and open a pull request describing what changed and how you tested it.
