use crate::{
    caption_overlay::{CaptionOverlays, Overlay},
    export_batch::{self, Update},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Mutex,
};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const MIN_CLIP: f64 = 0.05;
const MAX_CLIPS: usize = 100;
const EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mts", "m2ts", "wmv", "mpg", "mpeg", "ts", "3gp",
];

type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct PreviewFiles(Mutex<Vec<tempfile::TempDir>>);

#[derive(Default)]
pub struct Exports {
    batch: Mutex<()>,
    folder: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    path: PathBuf,
    name: String,
    duration: f64,
    width: u64,
    height: u64,
}

#[derive(Clone, Copy, Deserialize)]
pub struct Clip {
    pub(crate) start: f64,
    pub(crate) end: f64,
}

#[derive(Deserialize)]
pub struct ExportClip {
    #[serde(flatten)]
    range: Clip,
    title: Option<String>,
    captions: Option<crate::caption_render::CaptionTrack>,
    #[serde(rename = "captionOverlay")]
    overlay_id: Option<String>,
    #[serde(skip)]
    overlay: Option<Overlay>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Portrait,
    Landscape,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Framing {
    Fill,
    Fit,
}

#[derive(Clone, Copy, Deserialize)]
pub struct FramePosition {
    x: u8,
    y: u8,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Compact,
    Compatible,
    Lossless,
}

impl Quality {
    fn args(self) -> &'static [&'static str] {
        match self {
            Self::Compact => &[
                "-c:v",
                "libx265",
                "-preset",
                "fast",
                "-crf",
                "24",
                "-tag:v",
                "hvc1",
                "-x265-params",
                "pools=2:frame-threads=1:log-level=error",
            ],
            Self::Compatible => &["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"],
            Self::Lossless => &["-c:v", "libx264", "-preset", "fast", "-qp", "0"],
        }
    }

    fn hardware_candidates(self) -> &'static [&'static [&'static str]] {
        match self {
            Self::Compact => &[
                &[
                    "-c:v",
                    "hevc_nvenc",
                    "-preset",
                    "p5",
                    "-rc",
                    "vbr",
                    "-cq",
                    "24",
                    "-b:v",
                    "0",
                    "-tag:v",
                    "hvc1",
                ],
                &[
                    "-c:v",
                    "hevc_qsv",
                    "-preset",
                    "medium",
                    "-global_quality",
                    "24",
                    "-tag:v",
                    "hvc1",
                ],
                &[
                    "-c:v", "hevc_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "22",
                    "-qp_p", "24", "-tag:v", "hvc1",
                ],
            ],
            Self::Compatible => &[
                &[
                    "-c:v",
                    "h264_nvenc",
                    "-preset",
                    "p5",
                    "-rc",
                    "vbr",
                    "-cq",
                    "19",
                    "-b:v",
                    "0",
                ],
                &[
                    "-c:v",
                    "h264_qsv",
                    "-preset",
                    "medium",
                    "-global_quality",
                    "19",
                ],
                &[
                    "-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "17",
                    "-qp_p", "19",
                ],
            ],
            Self::Lossless => &[],
        }
    }
}

fn hardware_encoder(quality: Quality, format: Format) -> Option<&'static [&'static str]> {
    let size = match format {
        Format::Portrait => "color=s=1080x1920:r=30",
        Format::Landscape => "color=s=1920x1080:r=30",
    };
    quality.hardware_candidates().iter().copied().find(|args| {
        ffmpeg()
            .args(["-f", "lavfi", "-i", size, "-frames:v", "1"])
            .args(*args)
            .args(["-pix_fmt", "yuv420p", "-f", "null", "-"])
            .output()
            .is_ok_and(|output| output.status.success())
    })
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ClipExport {
    Encoding { fraction: f64 },
    Saved { bytes: u64 },
    Failed { error: String },
}

#[derive(Serialize)]
pub struct Progress {
    index: usize,
    #[serde(flatten)]
    state: ClipExport,
}

#[derive(Clone, Copy, Deserialize)]
pub struct ExportOptions {
    format: Format,
    framing: Framing,
    position: FramePosition,
    quality: Quality,
}

fn command(tool: &str) -> Command {
    let mut command = Command::new(tool);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn launch_error(tool: &str, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return format!(
            "{tool} is missing. Add FFmpeg 8.0 or later to PATH and reopen MiniVidCut."
        );
    }
    format!("Could not start {tool}: {error}")
}

fn process_error(context: &str, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let details = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Unknown error");
    format!("{context}. {details}")
}

fn output(cmd: &mut Command, tool: &str, context: &str) -> Result<Output> {
    let output = cmd.output().map_err(|error| launch_error(tool, error))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(process_error(context, &output.stderr))
    }
}

fn source(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || !path.is_file() {
        return Err("Choose an existing video file.".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err("Choose a supported video, such as MP4, MOV, MKV or WebM.".into());
    }
    Ok(path.to_path_buf())
}

fn probe(path: PathBuf) -> Result<VideoInfo> {
    let output = output(
        command("ffprobe")
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-select_streams",
                "V:0",
                "-show_entries",
                "format=duration:stream=width,height,duration:stream_side_data=rotation",
                "-of",
                "json",
            ])
            .arg(&path),
        "ffprobe",
        "Could not read this video",
    )?;
    let data: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let stream = &data["streams"][0];
    let mut width = stream["width"].as_u64().unwrap_or_default();
    let mut height = stream["height"].as_u64().unwrap_or_default();
    if stream["side_data_list"][0]["rotation"]
        .as_i64()
        .unwrap_or_default()
        % 180
        != 0
    {
        std::mem::swap(&mut width, &mut height);
    }
    let duration = [&stream["duration"], &data["format"]["duration"]]
        .iter()
        .filter_map(|value| value.as_str()?.parse::<f64>().ok())
        .find(|value| value.is_finite() && *value >= MIN_CLIP)
        .unwrap_or_default();
    if width == 0 || height == 0 || duration == 0.0 {
        return Err("This file has no readable video track with a known duration.".into());
    }
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(VideoInfo {
        path,
        name,
        duration,
        width,
        height,
    })
}

pub(crate) async fn background<T: Send + 'static>(
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_video(app: AppHandle, path: PathBuf) -> Result<VideoInfo> {
    background(move || {
        let video = probe(source(&path)?)?;
        app.asset_protocol_scope()
            .allow_file(&video.path)
            .map_err(|error| error.to_string())?;
        Ok(video)
    })
    .await
}

fn ffmpeg() -> Command {
    let mut cmd = command("ffmpeg");
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"]);
    cmd
}

fn input<'a>(cmd: &'a mut Command, path: &Path) -> &'a mut Command {
    cmd.args(["-protocol_whitelist", "file", "-i"]).arg(path)
}

pub(crate) fn caption_audio(path: &Path, mut range: Clip, pcm: &Path) -> Result<f64> {
    let video = probe(source(path)?)?;
    validate_clips(std::slice::from_mut(&mut range), video.duration)?;
    let duration = range.end - range.start;
    let mut cmd = ffmpeg();
    cmd.args(["-ss", &format!("{:.6}", range.start)]);
    let output = input(&mut cmd, &video.path)
        .args([
            "-t",
            &format!("{duration:.6}"),
            "-map",
            "0:a:0?",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-af",
            "aresample=16000:async=1:first_pts=0",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
        ])
        .arg(pcm)
        .output()
        .map_err(|error| launch_error("ffmpeg", error))?;
    if !output.status.success() {
        if String::from_utf8_lossy(&output.stderr).contains("does not contain any stream") {
            return Err("This video has no audio track to caption.".into());
        }
        return Err(process_error(
            "Could not read the clip’s audio",
            &output.stderr,
        ));
    }
    Ok(duration)
}

fn thumbnail_at(path: &Path, time: f64) -> Result<String> {
    let mut cmd = ffmpeg();
    cmd.args([
        "-filter_threads",
        "1",
        "-threads:v",
        "1",
        "-ss",
        &format!("{time:.6}"),
    ]);
    input(&mut cmd, path).args([
        "-map",
        "0:V:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=176:100:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1",
        "-c:v",
        "mjpeg",
        "-threads",
        "1",
        "-f",
        "image2pipe",
        "pipe:1",
    ]);
    let frame = output(&mut cmd, "ffmpeg", "Could not render thumbnail")?;
    if frame.stdout.is_empty() {
        return Err("There is no frame at this point in the video.".into());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(frame.stdout)
    ))
}

#[tauri::command]
pub async fn clip_thumbnail(path: PathBuf, start: f64) -> Result<String> {
    background(move || {
        if !start.is_finite() || start < 0.0 {
            return Err("Invalid clip start.".into());
        }
        thumbnail_at(&source(&path)?, start)
    })
    .await
}

#[tauri::command]
pub async fn thumbnails(path: PathBuf, duration: f64) -> Result<Vec<String>> {
    background(move || {
        let path = source(&path)?;
        if !duration.is_finite() || duration < MIN_CLIP {
            return Err("Invalid video duration.".into());
        }
        Ok((0..10)
            .map(|index| {
                thumbnail_at(&path, duration * (f64::from(index) + 0.35) / 10.0).unwrap_or_default()
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn prepare_preview(app: AppHandle, path: PathBuf) -> Result<PathBuf> {
    background(move || {
        let path = source(&path)?;
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let preview = folder.path().join("preview.mp4");
        let mut cmd = ffmpeg();
        input(&mut cmd, &path).args(["-map", "0:V:0", "-map", "0:a:0?", "-sn", "-dn",
            "-vf", "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart"]).arg(&preview);
        output(&mut cmd, "ffmpeg", "Could not create a playable preview")?;
        app.asset_protocol_scope().allow_file(&preview).map_err(|error| error.to_string())?;
        app.state::<PreviewFiles>().0.lock().map_err(|error| error.to_string())?.push(folder);
        Ok(preview)
    }).await
}

fn validate_clips(clips: &mut [Clip], duration: f64) -> Result<()> {
    if clips.is_empty() || clips.len() > MAX_CLIPS {
        return Err(format!("Choose between 1 and {MAX_CLIPS} clips."));
    }
    for clip in clips {
        if !clip.start.is_finite()
            || !clip.end.is_finite()
            || clip.start < 0.0
            || clip.end > duration + 0.04
        {
            return Err("A clip falls outside the video.".into());
        }
        clip.end = clip.end.min(duration);
        if clip.end - clip.start + 0.000_001 < MIN_CLIP {
            return Err("Every clip must be at least 0.05 seconds.".into());
        }
    }
    Ok(())
}

fn filter(format: Format, framing: Framing, position: FramePosition) -> Result<String> {
    let FramePosition { x, y } = position;
    if x > 100 || y > 100 {
        return Err("Frame position must be between 0% and 100%.".into());
    }
    let (width, height) = match format {
        Format::Portrait => (1080, 1920),
        Format::Landscape => (1920, 1080),
    };
    let (scale, frame) = match framing {
        Framing::Fill => (
            "increase",
            format!("crop={width}:{height}:(iw-ow)*{x}/100:(ih-oh)*{y}/100"),
        ),
        Framing::Fit => (
            "decrease",
            format!("pad={width}:{height}:(ow-iw)*{x}/100:(oh-ih)*{y}/100:black"),
        ),
    };
    Ok(format!("scale={width}:{height}:force_original_aspect_ratio={scale}:force_divisible_by=2:reset_sar=1,{frame}"))
}

#[derive(Clone, Copy, Default)]
struct CaptionLayers<'a> {
    legacy: Option<(&'a crate::caption_render::CaptionTrack, Format)>,
    overlay: Option<&'a Overlay>,
}

fn encode_clip(
    path: &Path,
    clip: Clip,
    filter: &str,
    quality: Quality,
    destination: &Path,
    captions: CaptionLayers<'_>,
    on_progress: impl Fn(f64),
) -> Result<()> {
    encode_with(
        path,
        clip,
        filter,
        quality.args(),
        destination,
        captions,
        on_progress,
    )
}

fn encode_with(
    path: &Path,
    clip: Clip,
    filter: &str,
    encoder: &[&str],
    destination: &Path,
    captions: CaptionLayers<'_>,
    on_progress: impl Fn(f64),
) -> Result<()> {
    let mut cmd = ffmpeg();
    let duration = clip.end - clip.start;
    // Use a fixed relative filename so Windows drive letters and user paths
    // never enter FFmpeg's filter expression.
    let subtitles = captions
        .legacy
        .filter(|_| captions.overlay.is_none())
        .filter(|(track, _)| !track.cues.is_empty())
        .map(|(track, format)| {
            let directory = tempfile::tempdir()?;
            let (width, height) = match format {
                Format::Landscape => (1920, 1080),
                Format::Portrait => (1080, 1920),
            };
            std::fs::write(
                directory.path().join("captions.ass"),
                track.ass(width, height, duration),
            )?;
            Ok::<_, std::io::Error>(directory)
        })
        .transpose()
        .map_err(|error| format!("Could not prepare captions for export: {error}"))?;
    let caption_filter;
    let filter = if let Some(directory) = &subtitles {
        cmd.current_dir(directory.path());
        caption_filter = format!("{filter},ass=filename=captions.ass");
        &caption_filter
    } else {
        filter
    };
    let log = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut read_log = log.try_clone().map_err(|error| error.to_string())?;
    cmd.args([
        "-filter_threads",
        "1",
        "-threads:v",
        "1",
        "-ss",
        &format!("{:.6}", clip.start),
    ]);
    input(&mut cmd, path);
    if let Some(overlay) = captions.overlay {
        let graph = format!("[0:V:0]{filter}[video];[video][1:v]overlay=x={}:y={}:eof_action=pass:repeatlast=0[captioned]", overlay.x, overlay.y);
        cmd.current_dir(overlay.directory.path()).args([
            "-f",
            "concat",
            "-safe",
            "0",
            "-protocol_whitelist",
            "file",
            "-i",
            "captions.ffconcat",
            "-filter_complex_threads",
            "1",
            "-filter_complex",
            &graph,
            "-map",
            "[captioned]",
        ]);
    } else {
        cmd.args(["-map", "0:V:0", "-vf", filter]);
    }
    cmd.args([
        "-t",
        &format!("{duration:.6}"),
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
    ])
    .args(encoder)
    .args([
        "-threads:v",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-abort_on",
        "empty_output",
        "-progress",
        "pipe:1",
        "-f",
        "mp4",
    ])
    .arg(destination);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .map_err(|error| launch_error("ffmpeg", error))?;
    let stdout = BufReader::new(child.stdout.take().expect("FFmpeg stdout was piped"));
    for line in stdout.lines().map_while(std::result::Result::ok) {
        if let Some(time) = line
            .strip_prefix("out_time_us=")
            .and_then(|value| value.parse::<f64>().ok())
        {
            on_progress((time / 1_000_000.0 / duration).clamp(0.0, 0.99));
        }
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        use std::io::{Read, Seek};
        let mut details = Vec::new();
        let _ = read_log
            .rewind()
            .and_then(|()| read_log.take(32_768).read_to_end(&mut details));
        return Err(process_error("Export failed", &details));
    }
    Ok(())
}

fn save_clip(clip: tempfile::NamedTempFile, folder: &Path, name: &str) -> Result<PathBuf> {
    let mut clip = clip;
    for copy in 1..=10_000 {
        let filename = if copy == 1 {
            format!("{name}.mp4")
        } else {
            format!("{name} ({copy}).mp4")
        };
        let path = folder.join(filename);
        match clip.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                clip = error.file
            }
            Err(error) => return Err(format!("Could not save the clip: {}", error.error)),
        }
    }
    Err("Too many existing clips have the same name.".into())
}

fn export_name(title: Option<&str>, stem: &str, index: usize) -> String {
    let name: String = title
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    let name = match name.get(name.len().saturating_sub(4)..) {
        Some(extension) if extension.eq_ignore_ascii_case(".mp4") => {
            name[..name.len() - 4].trim_end_matches([' ', '.'])
        }
        _ => name,
    };
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        device.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        device.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if name.is_empty() {
        format!("{stem} - Clip {:02}", index + 1)
    } else if reserved {
        format!("_{name}")
    } else {
        name.into()
    }
}

fn encode_batch(
    path: &Path,
    folder: &Path,
    clips: &[ExportClip],
    options: ExportOptions,
    mut progress: impl FnMut(Progress),
) -> Result<Vec<ClipExport>> {
    let filter = filter(options.format, options.framing, options.position)?;
    let stem: String = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .take(60)
        .collect();
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    let hardware = hardware_encoder(options.quality, options.format);
    let mut results = vec![None; clips.len()];
    export_batch::run(
        clips.len(),
        export_batch::worker_count(clips.len(), cpus),
        |index, report| -> Result<u64> {
            let clip = &clips[index];
            let output = tempfile::Builder::new()
                .prefix(".minividcut-")
                .suffix(".mp4")
                .tempfile_in(folder)
                .map_err(|error| format!("Could not write in this folder: {error}"))?;
            let captions = CaptionLayers {
                legacy: clip.captions.as_ref().map(|track| (track, options.format)),
                overlay: clip.overlay.as_ref(),
            };
            let accelerated = hardware.is_some_and(|args| {
                encode_with(
                    path,
                    clip.range,
                    &filter,
                    args,
                    output.path(),
                    captions,
                    report,
                )
                .is_ok()
            });
            if !accelerated {
                encode_clip(
                    path,
                    clip.range,
                    &filter,
                    options.quality,
                    output.path(),
                    captions,
                    report,
                )?;
            }
            let bytes = output
                .as_file()
                .metadata()
                .map_err(|error| error.to_string())?
                .len();
            save_clip(
                output,
                folder,
                &export_name(clip.title.as_deref(), &stem, index),
            )?;
            Ok(bytes)
        },
        |index, event| {
            let state = match event {
                Update::Encoding(fraction) => ClipExport::Encoding { fraction },
                Update::Finished(result) => {
                    let state = match result {
                        Ok(bytes) => ClipExport::Saved { bytes },
                        Err(error) => ClipExport::Failed { error },
                    };
                    results[index] = Some(state.clone());
                    state
                }
            };
            progress(Progress { index, state });
        },
    );
    results
        .into_iter()
        .map(|result| result.ok_or_else(|| "An export worker did not finish.".into()))
        .collect()
}

#[tauri::command]
pub async fn export_clips(
    app: AppHandle,
    path: PathBuf,
    folder: PathBuf,
    mut clips: Vec<ExportClip>,
    options: ExportOptions,
    progress: Channel<Progress>,
) -> Result<Vec<ClipExport>> {
    background(move || {
        let exports = app.state::<Exports>();
        let _batch = exports
            .batch
            .try_lock()
            .map_err(|_| "An export is already running.")?;
        let video = probe(source(&path)?)?;
        let mut ranges: Vec<_> = clips.iter().map(|clip| clip.range).collect();
        validate_clips(&mut ranges, video.duration)?;
        for (clip, range) in clips.iter_mut().zip(ranges) {
            clip.range = range;
        }
        let overlays = app.state::<CaptionOverlays>();
        let (width, height) = match options.format {
            Format::Landscape => (1920, 1080),
            Format::Portrait => (1080, 1920),
        };
        for clip in &mut clips {
            if let Some(id) = &clip.overlay_id {
                let overlay = overlays.take(id)?;
                if !overlay.fits(width, height) {
                    return Err("Caption artwork falls outside the output frame.".into());
                }
                clip.overlay = Some(overlay);
            }
        }
        if !folder.is_absolute() || !folder.is_dir() {
            return Err("Choose an existing export folder.".into());
        }
        if clips.iter().any(|clip| {
            clip.overlay.is_none()
                && clip
                    .captions
                    .as_ref()
                    .is_some_and(|track| !track.cues.is_empty())
        }) {
            let filters = output(
                command("ffmpeg").args(["-hide_banner", "-filters"]),
                "ffmpeg",
                "Could not list video filters",
            )?;
            if !String::from_utf8_lossy(&filters.stdout)
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some("ass"))
            {
                return Err("Captioned exports require an FFmpeg build with libass.".into());
            }
        }
        let results = encode_batch(&video.path, &folder, &clips, options, |event| {
            let _ = progress.send(event);
        })?;
        if results
            .iter()
            .any(|state| matches!(state, ClipExport::Saved { .. }))
        {
            *exports.folder.lock().map_err(|error| error.to_string())? = Some(folder);
        }
        Ok(results)
    })
    .await
}

#[tauri::command]
pub fn open_export_folder(app: AppHandle) -> Result<()> {
    let folder = app
        .state::<Exports>()
        .folder
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or("Export a clip first.")?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ranges_and_clamps_container_rounding() {
        let mut clip = [Clip {
            start: 1.0,
            end: 3.02,
        }];
        assert!(validate_clips(&mut clip, 3.0).is_ok());
        assert_eq!(clip[0].end, 3.0);
        for invalid in [
            Clip {
                start: f64::NAN,
                end: 3.0,
            },
            Clip {
                start: 2.99,
                end: 3.0,
            },
            Clip {
                start: 0.0,
                end: 3.1,
            },
        ] {
            assert!(validate_clips(&mut [invalid], 3.0).is_err());
        }
    }

    #[test]
    fn preserves_existing_files_when_export_names_collide() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join("test.mp4"), "original").unwrap();
        let temporary = tempfile::NamedTempFile::new_in(folder.path()).unwrap();
        let path = save_clip(temporary, folder.path(), "test").unwrap();
        assert_eq!(path.file_name().unwrap(), "test (2).mp4");
        assert_eq!(
            std::fs::read_to_string(folder.path().join("test.mp4")).unwrap(),
            "original"
        );
    }

    #[test]
    fn exports_both_frames_with_trimmed_audio() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source with spaces.mp4");
        let mut fixture = ffmpeg();
        fixture
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
            ])
            .arg(&source);
        output(&mut fixture, "ffmpeg", "Could not create test video").unwrap();
        for (format, framing, dimensions) in [
            (Format::Portrait, Framing::Fill, (1080, 1920)),
            (Format::Landscape, Framing::Fit, (1920, 1080)),
        ] {
            let path = folder.path().join(format!("{}.mp4", dimensions.0));
            encode_clip(
                &source,
                Clip {
                    start: 0.5,
                    end: 1.5,
                },
                &filter(format, framing, FramePosition { x: 50, y: 50 }).unwrap(),
                Quality::Compatible,
                &path,
                CaptionLayers::default(),
                |_| {},
            )
            .unwrap();
            let info = probe(path.clone()).unwrap();
            assert_eq!((info.width, info.height), dimensions);
            assert!((info.duration - 1.0).abs() < 0.05);
            let audio = output(
                command("ffprobe")
                    .args([
                        "-v",
                        "error",
                        "-select_streams",
                        "a:0",
                        "-show_entries",
                        "stream=codec_name",
                        "-of",
                        "csv=p=0",
                    ])
                    .arg(path),
                "ffprobe",
                "No audio",
            )
            .unwrap();
            assert_eq!(String::from_utf8_lossy(&audio.stdout).trim(), "aac");
        }
    }

    #[test]
    fn composites_timed_caption_artwork_at_its_exact_position() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.mp4");
        output(
            ffmpeg()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=320x180:r=30:d=2",
                    "-c:v",
                    "libx264",
                ])
                .arg(&path),
            "ffmpeg",
            "Could not make a test source",
        )
        .unwrap();
        let mut images = Vec::new();
        for color in ["black@0", "red", "blue"] {
            images.push(
                output(
                    ffmpeg().args([
                        "-f",
                        "lavfi",
                        "-i",
                        &format!("color={color}:s=80x40,format=rgba"),
                        "-frames:v",
                        "1",
                        "-threads",
                        "1",
                        "-c:v",
                        "png",
                        "-f",
                        "image2pipe",
                        "pipe:1",
                    ]),
                    "ffmpeg",
                    "Could not make test artwork",
                )
                .unwrap()
                .stdout,
            );
        }
        let header = serde_json::to_vec(&serde_json::json!({
            "x": 240, "y": 320, "width": 80, "height": 40,
            "sizes": images.iter().map(Vec::len).collect::<Vec<_>>(),
            "frames": [{ "at": 0, "image": 0 }, { "at": 153, "image": 1 }, { "at": 365, "image": 2 }, { "at": 661, "image": 0 }]
        })).unwrap();
        let mut payload = (header.len() as u32).to_le_bytes().to_vec();
        payload.extend(header);
        payload.extend(images.into_iter().flatten());
        let overlay = crate::caption_overlay::prepare(&payload).unwrap();
        let destination = folder.path().join("captioned.mp4");
        let clip = Clip {
            start: 0.5,
            end: 1.5,
        };
        let filter = filter(
            Format::Landscape,
            Framing::Fill,
            FramePosition { x: 50, y: 50 },
        )
        .unwrap();
        encode_clip(
            &path,
            clip,
            &filter,
            Quality::Compatible,
            &destination,
            CaptionLayers {
                legacy: None,
                overlay: Some(&overlay),
            },
            |_| {},
        )
        .unwrap();
        let sample = |time: &str, x: &str| {
            let mut cmd = ffmpeg();
            cmd.args(["-ss", time]);
            output(
                input(&mut cmd, &destination).args([
                    "-vf",
                    &format!("crop=2:2:{x}:340,format=rgb24"),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]),
                "ffmpeg",
                "Could not read sample pixel",
            )
            .unwrap()
            .stdout
        };
        assert!(sample("0.10", "280")[0] < 20);
        assert!(sample("0.20", "280")[0] > 200);
        assert!(sample("0.20", "420")[0] < 20);
        assert!(sample("0.40", "280")[2] > 200);
        assert!(sample("0.70", "280")[2] < 20);
    }

    #[test]
    fn burns_captions_at_clip_relative_times_in_both_formats() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("dark source.mp4");
        output(
            ffmpeg()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=320x180:r=10:d=2",
                    "-c:v",
                    "libx264",
                ])
                .arg(&path),
            "ffmpeg",
            "Could not make a test source",
        )
        .unwrap();
        let track: crate::caption_render::CaptionTrack =
            serde_json::from_value(serde_json::json!({
                "style": { "preset": "boxed", "position": "bottom", "size": "medium" },
                "cues": [{ "start": 0.2, "end": 0.6, "text": "Caption in the frame" }]
            }))
            .unwrap();
        for format in [Format::Portrait, Format::Landscape] {
            let destination = folder.path().join("captioned output.mp4");
            let framing = filter(format, Framing::Fit, FramePosition { x: 50, y: 50 }).unwrap();
            encode_clip(
                &path,
                Clip {
                    start: 0.5,
                    end: 1.5,
                },
                &framing,
                Quality::Compatible,
                &destination,
                CaptionLayers {
                    legacy: Some((&track, format)),
                    overlay: None,
                },
                |_| {},
            )
            .unwrap();
            let peak = |time: &str| {
                let mut cmd = ffmpeg();
                cmd.args(["-ss", time]);
                let frame = output(
                    input(&mut cmd, &destination).args([
                        "-frames:v",
                        "1",
                        "-pix_fmt",
                        "gray",
                        "-f",
                        "rawvideo",
                        "pipe:1",
                    ]),
                    "ffmpeg",
                    "Could not read a test frame",
                )
                .unwrap();
                *frame.stdout.iter().max().unwrap()
            };
            assert!(peak("0.1") < 20);
            assert!(peak("0.4") > 200);
            assert!(peak("0.8") < 20);
        }
    }

    #[test]
    fn shifts_exported_portrait_to_the_requested_side() {
        for (x, dominant) in [(0, 0), (50, 1), (100, 2)] {
            let filters =
                filter(Format::Portrait, Framing::Fill, FramePosition { x, y: 50 }).unwrap();
            let filters = format!("{filters},crop=2:2,format=rgb24");
            let result = output(
                ffmpeg().args([
                    "-f", "lavfi", "-i",
                    "color=green:s=360x90,drawbox=x=0:y=0:w=120:h=90:c=red:t=fill,drawbox=x=240:y=0:w=120:h=90:c=blue:t=fill",
                    "-vf", &filters, "-frames:v", "1", "-f", "rawvideo", "pipe:1",
                ]),
                "ffmpeg",
                "Could not render positioned portrait",
            ).unwrap();
            let pixel = &result.stdout[..3];
            assert!(pixel[dominant] > 100);
            assert!(pixel
                .iter()
                .enumerate()
                .all(|(channel, &value)| channel == dominant || value < 30));
        }
        assert!(filter(
            Format::Portrait,
            Framing::Fill,
            FramePosition { x: 101, y: 50 }
        )
        .is_err());
    }

    #[test]
    fn export_titles_keep_default_names_and_sanitize_windows_paths() {
        assert_eq!(export_name(None, "Video", 3), "Video - Clip 04");
        assert_eq!(export_name(Some(" Opening.mp4 "), "Video", 3), "Opening");
        assert_eq!(
            export_name(Some("Part / two: intro"), "Video", 3),
            "Part _ two_ intro"
        );
        assert_eq!(export_name(Some("NUL.mp4"), "Video", 3), "_NUL");
        assert_eq!(export_name(Some("..."), "Video", 3), "Video - Clip 04");
    }

    #[test]
    fn exports_ten_compact_clips_in_order_and_reports_their_sizes() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("test source.mp4");
        output(
            ffmpeg()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=24",
                    "-t",
                    "2",
                    "-c:v",
                    "libx264",
                ])
                .arg(&source),
            "ffmpeg",
            "Could not make a test source",
        )
        .unwrap();
        let clips: Vec<_> = (0..10)
            .map(|index| {
                let start = f64::from(index) / 8.0;
                ExportClip {
                    range: Clip {
                        start,
                        end: start + 0.125,
                    },
                    title: (index == 0).then(|| "Opening".to_owned()),
                    captions: None,
                    overlay_id: None,
                    overlay: None,
                }
            })
            .collect();
        let mut saved = [false; 10];
        let results = encode_batch(
            &source,
            folder.path(),
            &clips,
            ExportOptions {
                format: Format::Landscape,
                framing: Framing::Fill,
                position: FramePosition { x: 50, y: 50 },
                quality: Quality::Compact,
            },
            |event| {
                if matches!(event.state, ClipExport::Saved { .. }) {
                    assert!(!saved[event.index]);
                    saved[event.index] = true;
                }
            },
        )
        .unwrap();
        assert!(saved.into_iter().all(|value| value));
        for (index, result) in results.into_iter().enumerate() {
            let ClipExport::Saved { bytes } = result else {
                panic!("clip {} failed", index + 1)
            };
            let filename = if index == 0 {
                "Opening.mp4".into()
            } else {
                format!("test source - Clip {:02}.mp4", index + 1)
            };
            let path = folder.path().join(filename);
            assert_eq!(std::fs::metadata(&path).unwrap().len(), bytes);
            assert!(bytes > 0);
        }
        let encoded = output(
            command("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=codec_name",
                    "-of",
                    "csv=p=0",
                ])
                .arg(folder.path().join("test source - Clip 10.mp4")),
            "ffprobe",
            "Could not inspect the exported clip",
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&encoded.stdout).trim(), "hevc");
        let first = thumbnail_at(&source, 0.0).unwrap();
        let later = thumbnail_at(&source, 1.0).unwrap();
        assert!(first.starts_with("data:image/jpeg;base64,"));
        assert_ne!(first, later);
    }

    #[test]
    fn lossless_mode_preserves_rendered_video_frames() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.mp4");
        let destination = folder.path().join("lossless.mp4");
        output(
            ffmpeg()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=24",
                    "-t",
                    "0.5",
                    "-c:v",
                    "libx264",
                ])
                .arg(&source),
            "ffmpeg",
            "Could not make a test source",
        )
        .unwrap();
        let filter = filter(
            Format::Portrait,
            Framing::Fit,
            FramePosition { x: 50, y: 50 },
        )
        .unwrap();
        encode_clip(
            &source,
            Clip {
                start: 0.0,
                end: 0.5,
            },
            &filter,
            Quality::Lossless,
            &destination,
            CaptionLayers::default(),
            |_| {},
        )
        .unwrap();
        let hash = |path: &Path, filters: &str| {
            let mut cmd = ffmpeg();
            input(&mut cmd, path).args([
                "-vf", filters, "-pix_fmt", "yuv420p", "-f", "hash", "pipe:1",
            ]);
            output(&mut cmd, "ffmpeg", "Could not hash the decoded frames")
                .unwrap()
                .stdout
        };
        assert_eq!(hash(&source, &filter), hash(&destination, "null"));
    }
}
