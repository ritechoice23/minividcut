use crate::{
    bookends::{self, Assembly, AssetCache, Bookends},
    caption_overlay::{CaptionOverlays, Overlay},
    export_batch::{self, Update},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const MIN_CLIP: f64 = 0.05;
const MAX_CLIPS: usize = 100;
const EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mts", "m2ts", "wmv", "mpg", "mpeg", "ts", "3gp",
];

pub(crate) type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct PreviewFiles(Mutex<PreviewState>);

#[derive(Default)]
struct PreviewState {
    source: Option<PathBuf>,
    frame_rate: f64,
    request: u64,
    folder: Option<tempfile::TempDir>,
    sequence: Option<(String, Arc<AtomicBool>)>,
    sequence_folder: Option<tempfile::TempDir>,
}

#[derive(Default)]
pub struct Exports {
    batch: Mutex<Option<(String, Arc<AtomicBool>)>>,
    encoders: EncoderCache,
    folder: Mutex<Option<PathBuf>>,
}

type EncoderCache = Mutex<HashMap<(Quality, Format), Vec<&'static [&'static str]>>>;

const EXPORT_CANCELED: &str = "Export canceled.";

struct ExportJob<'a>(&'a Mutex<Option<(String, Arc<AtomicBool>)>>);

impl Drop for ExportJob<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}

fn check_export(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(EXPORT_CANCELED.into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    bytes: u64,
    #[serde(skip)]
    frame_rate: f64,
    path: PathBuf,
    name: String,
    pub(crate) duration: f64,
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
    music: Option<MusicSettings>,
    #[serde(default)]
    bookends: Bookends,
}

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq)]
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
    pub(crate) x: u8,
    pub(crate) y: u8,
}

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq)]
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
                &[
                    "-c:v",
                    "hevc_mf",
                    "-hw_encoding",
                    "1",
                    "-rate_control",
                    "quality",
                    "-quality",
                    "80",
                    "-tag:v",
                    "hvc1",
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
                &[
                    "-c:v",
                    "h264_mf",
                    "-hw_encoding",
                    "1",
                    "-rate_control",
                    "quality",
                    "-quality",
                    "85",
                ],
            ],
            Self::Lossless => &[&["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "lossless"]],
        }
    }
}

fn encoder_pixel_format(encoder: &str) -> &'static str {
    if encoder.ends_with("_mf") {
        "nv12"
    } else {
        "yuv420p"
    }
}

fn available_hardware_encoders(quality: Quality, format: Format) -> Vec<&'static [&'static str]> {
    let size = match format {
        Format::Portrait => "testsrc2=s=1080x1920:r=30",
        Format::Landscape => "testsrc2=s=1920x1080:r=30",
    };
    quality
        .hardware_candidates()
        .iter()
        .copied()
        .filter(|args| {
            ffmpeg()
                .args(["-f", "lavfi", "-i", size, "-frames:v", "4"])
                .args(*args)
                .args([
                    "-pix_fmt",
                    encoder_pixel_format(args[1]),
                    "-abort_on",
                    "empty_output",
                    "-f",
                    "null",
                    "-",
                ])
                .output()
                .is_ok_and(|output| output.status.success())
        })
        .collect()
}

fn encode_with_fallback(
    hardware: &[&'static [&'static str]],
    software: &'static [&'static str],
    mut encode: impl FnMut(&[&str]) -> Result<()>,
) -> Result<&'static str> {
    for &encoder in hardware {
        if encode(encoder).is_ok() {
            return Ok(encoder[1]);
        }
    }
    encode(software)?;
    Ok(software[1])
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ClipExport {
    Encoding { fraction: f64 },
    Saved { bytes: u64, encoder: &'static str },
    Failed { error: String },
    Canceled,
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

pub(crate) fn command(tool: &str) -> Command {
    let executable = std::env::current_exe().expect("Could not locate the MiniVidCut executable");
    let directory = executable
        .parent()
        .expect("Executable has a parent directory");
    // Cargo runs the test executable from the profile's deps folder.
    #[cfg(test)]
    let directory = directory
        .parent()
        .expect("Cargo profile directory is missing");
    let mut command = Command::new(directory.join(format!("{tool}.exe")));
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
            "MiniVidCut could not find its bundled {tool}. Reinstall MiniVidCut and try again."
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

pub(crate) fn output(cmd: &mut Command, tool: &str, context: &str) -> Result<Output> {
    let output = cmd.output().map_err(|error| launch_error(tool, error))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(process_error(context, &output.stderr))
    }
}

pub(crate) fn source(path: &Path) -> Result<PathBuf> {
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

pub(crate) fn probe(path: PathBuf) -> Result<VideoInfo> {
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
                "format=duration:stream=width,height,duration,avg_frame_rate:stream_side_data=rotation",
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
    let frame_rate = stream["avg_frame_rate"]
        .as_str()
        .and_then(|rate| rate.split_once('/'))
        .and_then(|(numerator, denominator)| {
            Some(numerator.parse::<f64>().ok()? / denominator.parse::<f64>().ok()?)
        })
        .filter(|rate| rate.is_finite())
        .unwrap_or_default();
    Ok(VideoInfo {
        frame_rate,
        bytes: std::fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len(),
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
pub async fn open_video(
    app: AppHandle,
    path: PathBuf,
    expected: Option<VideoIdentity>,
) -> Result<VideoInfo> {
    background(move || {
        let video = probe(source(&path)?)?;
        if expected.is_some_and(|expected| !expected.matches(&video)) {
            return Err(
                "This file differs from the saved draft source. Choose the original video.".into(),
            );
        }
        app.asset_protocol_scope()
            .allow_file(&video.path)
            .map_err(|error| error.to_string())?;
        let previews = app.state::<PreviewFiles>();
        let mut preview = previews.0.lock().map_err(|error| error.to_string())?;
        preview.request += 1;
        preview.source = Some(video.path.clone());
        preview.frame_rate = video.frame_rate;
        preview.folder = None;
        if let Some((_, cancel)) = preview.sequence.take() {
            cancel.store(true, Ordering::Relaxed);
        }
        preview.sequence_folder = None;
        Ok(video)
    })
    .await
}

#[derive(Deserialize)]
pub struct VideoIdentity {
    duration: f64,
    width: u64,
    height: u64,
    bytes: u64,
}

impl VideoIdentity {
    fn matches(&self, video: &VideoInfo) -> bool {
        self.duration == video.duration
            && self.width == video.width
            && self.height == video.height
            && self.bytes == video.bytes
    }
}

#[cfg(test)]
#[test]
fn draft_identity_allows_relocation_and_rejects_a_different_file_size() {
    let expected = VideoIdentity {
        duration: 5.0,
        width: 640,
        height: 360,
        bytes: 1024,
    };
    let mut video = VideoInfo {
        duration: 5.0,
        width: 640,
        height: 360,
        bytes: 1024,
        frame_rate: 30.0,
        path: PathBuf::from("relocated.mp4"),
        name: "relocated.mp4".into(),
    };
    assert!(expected.matches(&video));
    video.bytes += 1;
    assert!(!expected.matches(&video));
}

fn ffmpeg() -> Command {
    let mut cmd = command("ffmpeg");
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"]);
    cmd
}

pub(crate) fn input<'a>(cmd: &'a mut Command, path: &Path) -> &'a mut Command {
    cmd.args(["-protocol_whitelist", "file", "-i"]).arg(path)
}

const MUSIC_FORMATS: &str = "mp3,wav,flac,ogg,opus,aac,mov,mp4,m4a,3gp,3g2,mj2";

#[derive(Clone, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MusicTrack {
    Library { id: String },
    Kaino { id: String },
    File { path: PathBuf },
}

impl MusicTrack {
    fn path(&self, app: &AppHandle) -> Result<PathBuf> {
        let path = match self {
            Self::Library { id } => crate::music_library::downloaded_path(app, id)?,
            Self::Kaino { id } => crate::kaino::local_path(app, id)?,
            Self::File { path } => {
                let extension = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"]
                    .contains(&extension.as_str())
                {
                    return Err("Choose an MP3, WAV, M4A, AAC, FLAC, OGG or Opus file.".into());
                }
                path.clone()
            }
        };
        if !path.is_absolute() || !path.is_file() {
            return Err("Music file not found. Choose the track again.".into());
        }
        Ok(path)
    }
}

pub(crate) fn audio_stream(path: &Path, formats: Option<&str>) -> Result<bool> {
    let mut cmd = command("ffprobe");
    if let Some(formats) = formats {
        cmd.args(["-format_whitelist", formats]);
    }
    let probe = output(
        cmd.args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(path),
        "ffprobe",
        "Could not read the audio track",
    )?;
    Ok(!String::from_utf8_lossy(&probe.stdout).trim().is_empty())
}

#[tauri::command]
pub async fn open_music(app: AppHandle, track: MusicTrack) -> Result<PathBuf> {
    background(move || {
        let path = track.path(&app)?;
        if !audio_stream(&path, Some(MUSIC_FORMATS))? {
            return Err("This music file has no readable audio track.".into());
        }
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| error.to_string())?;
        Ok(path)
    })
    .await
}

#[derive(Deserialize)]
pub struct MusicSettings {
    track: MusicTrack,
    volume: u8,
}

struct MusicMix {
    path: PathBuf,
    volume: u8,
    source_audio: bool,
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
pub async fn thumbnails(
    path: PathBuf,
    duration: f64,
    times: Option<Vec<f64>>,
) -> Result<Vec<String>> {
    background(move || {
        let path = source(&path)?;
        if !duration.is_finite() || duration < MIN_CLIP {
            return Err("Invalid video duration.".into());
        }
        let times = times.unwrap_or_else(|| {
            (0..10)
                .map(|index| duration * (f64::from(index) + 0.35) / 10.0)
                .collect()
        });
        if times.len() > 12
            || times
                .iter()
                .any(|time| !time.is_finite() || *time < 0.0 || *time >= duration)
        {
            return Err("Invalid timeline thumbnail times.".into());
        }
        Ok(times
            .into_iter()
            .map(|time| thumbnail_at(&path, time).unwrap_or_default())
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn prepare_preview(app: AppHandle, path: PathBuf) -> Result<PathBuf> {
    background(move || {
        let path = source(&path)?;
        let previews = app.state::<PreviewFiles>();
        let (request, frame_rate) = {
            let mut state = previews.0.lock().map_err(|error| error.to_string())?;
            if state.source.as_ref() != Some(&path) {
                return Err("The source video changed.".into());
            }
            state.request += 1;
            (state.request, state.frame_rate)
        };
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let preview = folder.path().join("preview.mp4");
        let scale =
            "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1";
        let filter = if frame_rate > 30.0 {
            format!("fps=30,{scale}")
        } else {
            scale.to_owned()
        };
        let mut cmd = ffmpeg();
        input(&mut cmd, &path)
            .args([
                "-map",
                "0:V:0",
                "-map",
                "0:a:0?",
                "-sn",
                "-dn",
                "-vf",
                &filter,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "25",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ])
            .arg(&preview);
        let log = tempfile::tempfile().map_err(|error| error.to_string())?;
        let read_log = log.try_clone().map_err(|error| error.to_string())?;
        let mut child = cmd
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .map_err(|error| launch_error("ffmpeg", error))?;
        let status = loop {
            let current = previews
                .0
                .lock()
                .is_ok_and(|state| state.request == request);
            if !current {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The source video changed.".into());
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if !status.success() {
            return Err(read_process_error(
                "Could not create a playable preview",
                read_log,
            ));
        }
        let mut state = previews.0.lock().map_err(|error| error.to_string())?;
        if state.request != request {
            return Err("The source video changed.".into());
        }
        app.asset_protocol_scope()
            .allow_file(&preview)
            .map_err(|error| error.to_string())?;
        state.folder = Some(folder);
        Ok(preview)
    })
    .await
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

pub(crate) fn filter(format: Format, framing: Framing, position: FramePosition) -> Result<String> {
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

#[cfg(test)]
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
        None,
        None,
        &AtomicBool::new(false),
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
    music: Option<&MusicMix>,
    assembly: Option<(&Assembly, Option<&str>)>,
    cancel: &AtomicBool,
    on_progress: impl Fn(f64),
) -> Result<()> {
    check_export(cancel)?;
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
    let read_log = log.try_clone().map_err(|error| error.to_string())?;
    cmd.args([
        "-filter_threads",
        "1",
        "-threads:v",
        "1",
        "-ss",
        &format!("{:.6}", clip.start),
    ]);
    input(&mut cmd, path);
    let mut graph = Vec::new();
    let mut next_input = 1;
    if let Some(overlay) = captions.overlay {
        next_input += 1;
        graph.push(format!("[0:V:0]{filter}[video];[video][1:v]overlay=x={}:y={}:eof_action=pass:repeatlast=0[captioned]", overlay.x, overlay.y));
        cmd.current_dir(overlay.directory.path()).args([
            "-f",
            "concat",
            "-safe",
            "0",
            "-protocol_whitelist",
            "file",
            "-i",
            "captions.ffconcat",
        ]);
    }
    if let Some(music) = music {
        let index = next_input;
        next_input += 1;
        let gain = f64::from(music.volume) / 100.0;
        cmd.args(["-stream_loop", "-1", "-format_whitelist", MUSIC_FORMATS]);
        input(&mut cmd, &music.path);
        let level =
            format!("[{index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume={gain}");
        if music.source_audio {
            graph.push(format!("{level}[music]"));
            graph.push("[0:a:0]aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo[original]".into());
            graph.push("[original][music]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1[mixed]".into());
        } else {
            graph.push(format!("{level}[mixed]"));
        }
    }
    let duration = if let Some((assembly, preview_scale)) = assembly {
        let main_video = if captions.overlay.is_some() {
            "[captioned]"
        } else {
            graph.push(format!("[0:V:0]{filter}[framed]"));
            "[framed]"
        };
        let assembled_duration = assembly.append(
            &mut cmd,
            &mut graph,
            next_input,
            duration,
            main_video,
            music.is_some(),
        );
        if let Some(scale) = preview_scale {
            graph.push(format!("[final_v]{scale}[preview_v]"));
        }
        assembled_duration
    } else {
        duration
    };
    if !graph.is_empty() {
        cmd.args([
            "-filter_complex_threads",
            "1",
            "-filter_complex",
            &graph.join(";"),
        ]);
    }
    if let Some((_, preview_scale)) = assembly {
        cmd.args([
            "-map",
            if preview_scale.is_some() {
                "[preview_v]"
            } else {
                "[final_v]"
            },
        ]);
    } else if captions.overlay.is_some() {
        cmd.args(["-map", "[captioned]"]);
    } else {
        cmd.args(["-map", "0:V:0", "-vf", filter]);
    }
    cmd.args([
        "-t",
        &format!("{duration:.6}"),
        "-map",
        if assembly.is_some() {
            "[final_a]"
        } else if music.is_some() {
            "[mixed]"
        } else {
            "0:a:0?"
        },
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
        encoder_pixel_format(encoder[1]),
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
    let status = std::thread::scope(|scope| {
        let (send, receive) = std::sync::mpsc::channel();
        scope.spawn(move || {
            for line in stdout.lines().map_while(std::result::Result::ok) {
                if let Some(time) = line
                    .strip_prefix("out_time_us=")
                    .and_then(|value| value.parse::<f64>().ok())
                {
                    let _ = send.send(time);
                }
            }
        });
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            match receive.recv_timeout(Duration::from_millis(100)) {
                Ok(time) => on_progress((time / 1_000_000.0 / duration).clamp(0.0, 0.99)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Ok(status);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Ok(status);
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
        child.wait()
    })
    .map_err(|error| error.to_string())?;
    check_export(cancel)?;
    if !status.success() {
        return Err(read_process_error("Export failed", read_log));
    }
    Ok(())
}

fn read_process_error(context: &str, mut log: std::fs::File) -> String {
    use std::io::{Read, Seek};
    let mut details = Vec::new();
    let _ = log
        .rewind()
        .and_then(|()| log.take(32_768).read_to_end(&mut details));
    process_error(context, &details)
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

#[derive(Default)]
struct ClipMedia {
    music: Option<MusicMix>,
    assembly: Option<Assembly>,
}

fn resolve_clip_media(
    app: &AppHandle,
    clip: &ExportClip,
    assets: &mut AssetCache,
    music_paths: &mut HashMap<MusicTrack, Result<PathBuf>>,
    source_audio: bool,
    format: Format,
) -> Result<ClipMedia> {
    let music = clip
        .music
        .as_ref()
        .filter(|music| music.volume > 0)
        .map(|music| -> Result<MusicMix> {
            if music.volume > 100 {
                return Err("Music volume must be between 0 and 100%.".into());
            }
            let path = music_paths
                .entry(music.track.clone())
                .or_insert_with(|| music.track.path(app))
                .clone()?;
            Ok(MusicMix {
                path,
                volume: music.volume,
                source_audio,
            })
        })
        .transpose()?;
    let assembly = bookends::resolve(&clip.bookends, assets, source_audio, format)?;
    Ok(ClipMedia { music, assembly })
}

#[tauri::command]
pub async fn prepare_sequence_preview(
    app: AppHandle,
    path: PathBuf,
    mut clip: ExportClip,
    options: ExportOptions,
    request: String,
) -> Result<PathBuf> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let previews = app.state::<PreviewFiles>();
        let mut state = previews.0.lock().map_err(|error| error.to_string())?;
        if state.source.as_ref() != Some(&path) {
            return Err("The source video changed.".into());
        }
        if let Some((_, previous)) = state.sequence.replace((request.clone(), cancel.clone())) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    background(move || {
        let result = (|| -> Result<(tempfile::TempDir, PathBuf)> {
            check_export(&cancel)?;
            let info = probe(source(&path)?)?;
            validate_clips(std::slice::from_mut(&mut clip.range), info.duration)?;
            let framed = filter(options.format, options.framing, options.position)?;
            let media = resolve_clip_media(
                &app,
                &clip,
                &mut AssetCache::default(),
                &mut HashMap::new(),
                audio_stream(&path, None)?,
                options.format,
            )?;
            let overlay = clip
                .overlay_id
                .as_deref()
                .map(|id| app.state::<CaptionOverlays>().take(id))
                .transpose()?;
            let (width, height) = match options.format {
                Format::Landscape => (1920, 1080),
                Format::Portrait => (1080, 1920),
            };
            if overlay
                .as_ref()
                .is_some_and(|overlay| !overlay.fits(width, height))
            {
                return Err("Caption artwork falls outside the preview frame.".into());
            }
            let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
            let destination = folder.path().join("clip-preview.mp4");
            let size = format!("scale={}:{}", width / 2, height / 2);
            encode_with(
                &path,
                clip.range,
                &framed,
                &["-c:v", "libx264", "-preset", "ultrafast", "-crf", "25"],
                &destination,
                CaptionLayers {
                    legacy: None,
                    overlay: overlay.as_ref(),
                },
                media.music.as_ref(),
                media
                    .assembly
                    .as_ref()
                    .map(|assembly| (assembly, Some(size.as_str()))),
                &cancel,
                |_| {},
            )?;
            app.asset_protocol_scope()
                .allow_file(&destination)
                .map_err(|error| error.to_string())?;
            Ok((folder, destination))
        })();
        let previews = app.state::<PreviewFiles>();
        let mut state = previews.0.lock().map_err(|error| error.to_string())?;
        if state.sequence.as_ref().is_none_or(|(id, _)| id != &request) {
            return Err("The clip preview changed.".into());
        }
        state.sequence = None;
        check_export(&cancel)?;
        let (folder, path) = result?;
        state.sequence_folder = Some(folder);
        Ok(path)
    })
    .await
}

#[tauri::command]
pub fn cancel_sequence_preview(app: AppHandle, request: String) -> Result<()> {
    let previews = app.state::<PreviewFiles>();
    let state = previews.0.lock().map_err(|error| error.to_string())?;
    if let Some((id, cancel)) = &state.sequence {
        if id == &request {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

fn encode_batch(
    path: &Path,
    folder: &Path,
    clips: &[ExportClip],
    options: ExportOptions,
    media: Option<&[Result<ClipMedia>]>,
    encoders: &EncoderCache,
    cancel: &AtomicBool,
    workers: usize,
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
    let hardware = if cancel.load(Ordering::Relaxed) {
        Vec::new()
    } else {
        encoders
            .lock()
            .map_err(|error| error.to_string())?
            .entry((options.quality, options.format))
            .or_insert_with(|| available_hardware_encoders(options.quality, options.format))
            .clone()
    };
    let mut results = vec![None; clips.len()];
    export_batch::run(
        clips.len(),
        workers,
        |index, report| -> Result<(u64, &'static str)> {
            check_export(cancel)?;
            let clip = &clips[index];
            let empty = ClipMedia::default();
            let media = match media {
                Some(media) => media[index].as_ref().map_err(Clone::clone)?,
                None => &empty,
            };
            let output = tempfile::Builder::new()
                .prefix(".minividcut-")
                .suffix(".mp4")
                .tempfile_in(folder)
                .map_err(|error| format!("Could not write in this folder: {error}"))?;
            let captions = CaptionLayers {
                legacy: clip.captions.as_ref().map(|track| (track, options.format)),
                overlay: clip.overlay.as_ref(),
            };
            let furthest = std::cell::Cell::new(0.0_f64);
            let encoder = encode_with_fallback(&hardware, options.quality.args(), |args| {
                encode_with(
                    path,
                    clip.range,
                    &filter,
                    args,
                    output.path(),
                    captions,
                    media.music.as_ref(),
                    media.assembly.as_ref().map(|assembly| (assembly, None)),
                    cancel,
                    |fraction| {
                        if fraction > furthest.get() {
                            furthest.set(fraction);
                            report(fraction);
                        }
                    },
                )
            })?;
            let bytes = output
                .as_file()
                .metadata()
                .map_err(|error| error.to_string())?
                .len();
            check_export(cancel)?;
            save_clip(
                output,
                folder,
                &export_name(clip.title.as_deref(), &stem, index),
            )?;
            Ok((bytes, encoder))
        },
        |index, event| {
            let state = match event {
                Update::Encoding(_) if cancel.load(Ordering::Relaxed) => return,
                Update::Encoding(fraction) => ClipExport::Encoding { fraction },
                Update::Finished(result) => {
                    let state = match result {
                        Ok((bytes, encoder)) => ClipExport::Saved { bytes, encoder },
                        Err(error) if error == EXPORT_CANCELED => ClipExport::Canceled,
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
    progress: Channel<Option<Progress>>,
    job_id: String,
) -> Result<Vec<ClipExport>> {
    background(move || {
        let exports = app.state::<Exports>();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut active = exports.batch.lock().map_err(|error| error.to_string())?;
            if active.is_some() {
                return Err("An export is already running.".into());
            }
            *active = Some((job_id, cancel.clone()));
        }
        let _job = ExportJob(&exports.batch);
        let _ = progress.send(None);
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
        let cpus = std::thread::available_parallelism().map_or(1, usize::from);
        let workers = export_batch::worker_count(clips.len(), cpus);
        let source_audio = clips.iter().any(|clip| {
            clip.bookends.configured() || clip.music.as_ref().is_some_and(|music| music.volume > 0)
        }) && audio_stream(&video.path, None)?;
        let mut assets = AssetCache::default();
        let mut music_paths = HashMap::new();
        let media = clips
            .iter()
            .map(|clip| {
                check_export(&cancel)?;
                resolve_clip_media(
                    &app,
                    clip,
                    &mut assets,
                    &mut music_paths,
                    source_audio,
                    options.format,
                )
            })
            .collect::<Vec<_>>();
        let results = encode_batch(
            &video.path,
            &folder,
            &clips,
            options,
            Some(&media),
            &exports.encoders,
            &cancel,
            workers,
            |event| {
                let _ = progress.send(Some(event));
            },
        )?;
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
pub fn cancel_export(app: AppHandle, job_id: String) -> Result<()> {
    let exports = app.state::<Exports>();
    let active = exports.batch.lock().map_err(|error| error.to_string())?;
    if let Some((_, cancel)) = active.as_ref().filter(|(id, _)| *id == job_id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
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
    fn launches_bundled_media_tools_by_absolute_path() {
        let executable = std::env::current_exe().unwrap();
        let profile_dir = executable.parent().unwrap().parent().unwrap();
        for tool in ["ffmpeg", "ffprobe"] {
            let mut cmd = command(tool);
            assert_eq!(
                Path::new(cmd.get_program()),
                profile_dir.join(format!("{tool}.exe"))
            );

            let version = output(
                cmd.arg("-version").env("PATH", ""),
                tool,
                "Version check failed",
            )
            .unwrap();
            assert!(
                String::from_utf8_lossy(&version.stdout).starts_with(&format!("{tool} version "))
            );
        }
    }

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
        let music_path = folder.path().join("music.wav");
        output(
            ffmpeg()
                .args(["-f", "lavfi", "-i", "sine=frequency=880", "-t", "0.25"])
                .arg(&music_path),
            "ffmpeg",
            "Could not create test music",
        )
        .unwrap();
        let music = MusicMix {
            path: music_path,
            volume: 15,
            source_audio: false,
        };
        encode_with(
            &path,
            clip,
            &filter,
            Quality::Compatible.args(),
            &destination,
            CaptionLayers {
                legacy: None,
                overlay: Some(&overlay),
            },
            Some(&music),
            None,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(audio_stream(&destination, None).unwrap());
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
    fn exports_looped_music_at_the_requested_gain_with_or_without_source_audio() {
        let folder = tempfile::tempdir().unwrap();
        let music = folder.path().join("background music.wav");
        output(
            ffmpeg()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=880:sample_rate=48000",
                    "-t",
                    "0.25",
                ])
                .arg(&music),
            "ffmpeg",
            "Could not make test music",
        )
        .unwrap();
        for source_audio in [false, true] {
            let video = folder.path().join("source.mp4");
            let mut fixture = ffmpeg();
            fixture.args(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24"]);
            if source_audio {
                fixture.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]);
            }
            output(
                fixture.args(["-t", "2", "-c:v", "libx264"]).arg(&video),
                "ffmpeg",
                "Could not make test video",
            )
            .unwrap();
            let destination = folder.path().join("mixed.mp4");
            encode_with(
                &video,
                Clip {
                    start: 0.5,
                    end: 1.5,
                },
                "null",
                Quality::Compatible.args(),
                &destination,
                CaptionLayers {
                    legacy: None,
                    overlay: None,
                },
                Some(&MusicMix {
                    path: music.clone(),
                    volume: 25,
                    source_audio,
                }),
                None,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            let mut decode = ffmpeg();
            decode.args(["-ss", "0.8"]);
            let audio = output(
                input(&mut decode, &destination).args([
                    "-t", "0.1", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
                ]),
                "ffmpeg",
                "Could not read mixed audio near the end of the clip",
            )
            .unwrap();
            let samples: Vec<_> = audio
                .stdout
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect();
            assert_eq!(samples.len(), 4800);
            let amplitude = |frequency: f32| {
                let (sin, cos) =
                    samples
                        .iter()
                        .enumerate()
                        .fold((0.0, 0.0), |(sin, cos), (index, sample)| {
                            let phase = std::f32::consts::TAU * frequency * index as f32 / 48000.0;
                            (sin + sample * phase.sin(), cos + sample * phase.cos())
                        });
                2.0 * sin.hypot(cos) / samples.len() as f32
            };
            assert!((0.025..0.038).contains(&amplitude(880.0)));
            if source_audio {
                assert!((0.11..0.14).contains(&amplitude(440.0)));
            } else {
                assert!(amplitude(440.0) < 0.005);
            }
        }
    }

    #[test]
    fn assembles_intro_main_and_outro_with_an_audio_crossfade_and_a_silent_segment() {
        let directory = tempfile::tempdir().unwrap();
        let make_video = |name: &str, color: &str, audio: bool| {
            let path = directory.path().join(name);
            let mut fixture = ffmpeg();
            fixture.args(["-f", "lavfi", "-i", color]);
            if audio {
                fixture.args(["-f", "lavfi", "-i", "sine=frequency=660"]);
            }
            output(
                fixture.args(["-t", "1", "-c:v", "libx264"]).arg(&path),
                "ffmpeg",
                "Could not make test video",
            )
            .unwrap();
            path
        };
        let intro = make_video("intro clip.mp4", "color=red:s=128x72:r=24", true);
        let main = make_video("main.mp4", "color=green:s=160x90:r=30", false);
        let outro = make_video("outro clip.mp4", "color=blue:s=128x96:r=25", true);
        let mut cache = AssetCache::default();
        for (effect, expected) in [("cut", 3.0), ("fade", 2.0), ("slide", 2.0)] {
            let settings = serde_json::from_value(serde_json::json!({
                "intro": { "path": intro, "transition": effect },
                "outro": { "path": outro, "transition": effect }
            }))
            .unwrap();
            let assembly = bookends::resolve(&settings, &mut cache, false, Format::Landscape)
                .unwrap()
                .unwrap();
            let destination = directory.path().join(format!("{effect}.mp4"));
            encode_with(
                &main,
                Clip {
                    start: 0.0,
                    end: 1.0,
                },
                "scale=1920:1080",
                Quality::Compatible.args(),
                &destination,
                CaptionLayers {
                    legacy: None,
                    overlay: None,
                },
                None,
                Some((&assembly, None)),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            let duration = probe(destination.clone()).unwrap().duration;
            assert!((duration - expected).abs() <= 0.034, "{effect}: {duration}");
            assert!(audio_stream(&destination, None).unwrap());
            for (time, dominant) in [("0.1".to_owned(), 0), ((expected - 0.1).to_string(), 2)] {
                let mut sample = ffmpeg();
                sample.args(["-ss", &time]);
                let pixel = output(
                    input(&mut sample, &destination).args([
                        "-vf",
                        "scale=2:2,format=rgb24",
                        "-frames:v",
                        "1",
                        "-f",
                        "rawvideo",
                        "pipe:1",
                    ]),
                    "ffmpeg",
                    "Could not sample the exported video",
                )
                .unwrap()
                .stdout;
                assert!(pixel[dominant] > 200, "{effect}, {time}: {pixel:?}");
            }
        }
    }

    #[test]
    fn exports_still_bookends_at_the_configured_duration_and_position() {
        let directory = tempfile::tempdir().unwrap();
        let image = directory.path().join("title %03d.png");
        let main = directory.path().join("main.mp4");
        output(
            ffmpeg()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "color=red:s=90x160",
                    "-frames:v",
                    "1",
                    "-update",
                    "1",
                ])
                .arg(&image),
            "ffmpeg",
            "Could not create a test image",
        )
        .unwrap();
        output(
            ffmpeg()
                .args(["-f", "lavfi", "-i", "color=green:s=160x90:r=30", "-t", "1"])
                .arg(&main),
            "ffmpeg",
            "Could not create a test video",
        )
        .unwrap();
        let settings = serde_json::from_value(serde_json::json!({
            "intro": {"path": image, "transition": "cut", "duration": 0.5, "position": {"x": 0, "y": 50}},
            "outro": {"path": image, "transition": "fade", "duration": 1, "position": {"x": 100, "y": 50}}
        })).unwrap();
        let assembly = bookends::resolve(
            &settings,
            &mut AssetCache::default(),
            false,
            Format::Landscape,
        )
        .unwrap()
        .unwrap();
        let destination = directory.path().join("images.mp4");
        encode_with(
            &main,
            Clip {
                start: 0.0,
                end: 1.0,
            },
            "scale=1920:1080",
            Quality::Compatible.args(),
            &destination,
            CaptionLayers {
                legacy: None,
                overlay: None,
            },
            None,
            Some((&assembly, Some("scale=960:540"))),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!((probe(destination.clone()).unwrap().duration - 2.0).abs() < 0.035);
        for (time, x, should_be_red) in [
            ("0.2", 32, true),
            ("0.2", 920, false),
            ("1.8", 32, false),
            ("1.8", 920, true),
        ] {
            let mut sample = ffmpeg();
            sample.args(["-ss", time]);
            let bytes = output(
                input(&mut sample, &destination).args([
                    "-vf",
                    &format!("crop=2:2:{x}:250,format=rgb24"),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]),
                "ffmpeg",
                "Could not sample image position",
            )
            .unwrap()
            .stdout;
            assert_eq!(bytes[0] > 200, should_be_red, "{time}, {x}: {bytes:?}");
        }
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
                    music: None,
                    bookends: Bookends::default(),
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
            None,
            &EncoderCache::default(),
            &AtomicBool::new(false),
            2,
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
            let ClipExport::Saved { bytes, encoder } = result else {
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
            eprintln!("Compact clip {} encoder: {encoder}", index + 1);
            assert!(
                Quality::Compact
                    .hardware_candidates()
                    .iter()
                    .any(|args| args[1] == encoder)
                    || encoder == Quality::Compact.args()[1]
            );
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
    fn cancellation_keeps_finished_clips_and_cleans_up_temporary_outputs() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.mp4");
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
        let clips: Vec<_> = (0..3)
            .map(|index| ExportClip {
                range: Clip {
                    start: 0.0,
                    end: 2.0,
                },
                title: Some(format!("Clip {index}")),
                captions: None,
                overlay_id: None,
                overlay: None,
                music: None,
                bookends: Bookends::default(),
            })
            .collect();
        let cancel = AtomicBool::new(false);
        let cache = EncoderCache::new(HashMap::from([(
            (Quality::Compatible, Format::Landscape),
            Vec::new(),
        )]));
        let results = encode_batch(
            &source,
            folder.path(),
            &clips,
            ExportOptions {
                format: Format::Landscape,
                framing: Framing::Fit,
                position: FramePosition { x: 50, y: 50 },
                quality: Quality::Compatible,
            },
            None,
            &cache,
            &cancel,
            1,
            |event| {
                if event.index == 0 && matches!(event.state, ClipExport::Saved { .. }) {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap();
        assert!(results
            .iter()
            .any(|state| matches!(state, ClipExport::Canceled)));
        assert!(results
            .iter()
            .any(|state| matches!(state, ClipExport::Saved { .. })));
        for (index, state) in results.iter().enumerate() {
            assert_eq!(
                folder.path().join(format!("Clip {index}.mp4")).exists(),
                matches!(state, ClipExport::Saved { .. })
            );
        }
        assert!(!std::fs::read_dir(folder.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".minividcut-")));
    }

    #[test]
    fn active_encode_observes_cancellation_and_releases_the_output() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.mp4");
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
        let destination = tempfile::NamedTempFile::new_in(folder.path()).unwrap();
        let path = destination.path().to_owned();
        let cancel = AtomicBool::new(false);
        let result = encode_with(
            &source,
            Clip {
                start: 0.0,
                end: 2.0,
            },
            "scale=1920:1080",
            Quality::Compatible.args(),
            &path,
            CaptionLayers {
                legacy: None,
                overlay: None,
            },
            None,
            None,
            &cancel,
            |_| cancel.store(true, Ordering::Relaxed),
        );
        assert_eq!(result.unwrap_err(), EXPORT_CANCELED);
        destination.close().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn tries_other_gpu_encoders_before_cpu_and_reports_the_successful_encoder() {
        let hardware: &[&[&str]] = &[&["-c:v", "hevc_nvenc"], &["-c:v", "hevc_qsv"]];
        let mut attempted = Vec::new();
        let encoder = encode_with_fallback(hardware, Quality::Compact.args(), |args| {
            attempted.push(args[1].to_owned());
            if args[1] == "hevc_nvenc" {
                Err("GPU encode failed".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(encoder, "hevc_qsv");
        assert_eq!(attempted, ["hevc_nvenc", "hevc_qsv"]);

        let encoder = encode_with_fallback(hardware, Quality::Compact.args(), |args| {
            if args[1] == "libx265" {
                Ok(())
            } else {
                Err("GPU encode failed".into())
            }
        })
        .unwrap();
        assert_eq!(encoder, "libx265");
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
        let results = encode_batch(
            &source,
            folder.path(),
            &[ExportClip {
                range: Clip {
                    start: 0.0,
                    end: 0.5,
                },
                title: Some("auto-lossless".into()),
                captions: None,
                overlay_id: None,
                overlay: None,
                music: None,
                bookends: Bookends::default(),
            }],
            ExportOptions {
                format: Format::Portrait,
                framing: Framing::Fit,
                position: FramePosition { x: 50, y: 50 },
                quality: Quality::Lossless,
            },
            None,
            &EncoderCache::default(),
            &AtomicBool::new(false),
            1,
            |_| {},
        )
        .unwrap();
        let ClipExport::Saved { encoder, .. } = results[0] else {
            panic!("automatic lossless export failed");
        };
        eprintln!("Lossless export encoder: {encoder}");
        assert_eq!(
            hash(&source, &filter),
            hash(&folder.path().join("auto-lossless.mp4"), "null")
        );
    }
}
