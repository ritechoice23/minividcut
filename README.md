# MiniVidCut

![MiniVidCut banner with a lime-green clip selection on a dark timeline](docs/thumbnail.png)

**The simplest, smartest way to turn long videos into short clips.**

A lightweight Windows app for precise trimming and batch export. Built by [↗](https://github.com/ritechoice23) **Daramola Babatunde** (@ritechoice23).

Cut the best moments from any long video and reframe them for portrait or landscape.
Add automatic captions on your device and export all your clips in one batch.

Enable **Auto-title** in the Clips panel to name clips from their transcripts. The first title downloads a 229 MB language model and a 25 MB CPU runtime. Clips without captions also use the existing speech model. Double-click a clip title to edit it.

Use **Smart Split** above the timeline to find moments by description, such as “the funniest moments, no more than 30 seconds.” The search reuses available captions and transcribes missing portions in the background. Suggestions appear below the player and on the timeline as the search runs. Preview a suggestion or add it to the clip list.

## Built with

React, TypeScript, and Vite for the interface, Tauri and Rust for the desktop app, and FFmpeg for video processing.

## Run on Windows

The Windows x64 installer includes FFmpeg and FFprobe with the libraries needed for video export and subtitle rendering. Install and open MiniVidCut to start cutting videos. MiniVidCut uses the Windows WebView2 runtime.

Exports prefer NVIDIA NVENC, Intel Quick Sync, AMD AMF, or Windows Media Foundation hardware encoding when supported by the selected preset and your hardware. Lossless video uses NVIDIA NVENC when it supports lossless encoding. MiniVidCut falls back to software as needed. Each saved clip shows whether it used the GPU or CPU.

From source, install Node.js, Rust, and the Windows C++ build tools. Make sure CMake is on PATH, then run:

```powershell
npm ci
npm run tauri -- dev
```

Build a Windows installer with `npm run tauri -- build`. Run the trim and export tests with `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.

The first Rust build downloads and verifies a pinned static FFmpeg archive and caches the tools in `src-tauri/binaries`. The installer includes the FFmpeg license. [↗](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-11-13-12-43) **FFmpeg binary release** · [↗](https://github.com/FFmpeg/FFmpeg/tree/f1acb0a266) **FFmpeg source revision** · [↗](https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/c9fe5114060e507409f7ee07edfd82efaf25d767) **Build scripts**

MiniVidCut saves one local recovery draft. Use **Resume draft** after restarting or **Locate video** if you moved the original. **Cancel export** stops the batch and keeps clips that have already been saved.

## License

MiniVidCut is available under the MIT license. The bundled FFmpeg and FFprobe are GPL-3.0-or-later and include their own license and third-party notice.

## Contributing

Bug reports, documentation fixes, and small improvements are welcome. For bugs, open an issue with the steps to reproduce and your Windows and MiniVidCut versions. To contribute a change, fork the repo, run the relevant tests above, and open a pull request describing what changed and how you tested it.
