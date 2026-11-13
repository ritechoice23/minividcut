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
pub struct ExportFolder(Mutex<Option<PathBuf>>);

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
    start: f64,
    end: f64,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    completed: usize,
    total: usize,
    fraction: f64,
}

#[derive(Serialize)]
pub struct ExportResult {
    files: Vec<PathBuf>,
    error: Option<String>,
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

async fn background<T: Send + 'static>(
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

fn filter(format: Format, framing: Framing) -> String {
    let (width, height) = match format {
        Format::Portrait => (1080, 1920),
        Format::Landscape => (1920, 1080),
    };
    let (scale, frame) = match framing {
        Framing::Fill => ("increase", format!("crop={width}:{height}")),
        Framing::Fit => (
            "decrease",
            format!("pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black"),
        ),
    };
    format!("scale={width}:{height}:force_original_aspect_ratio={scale}:force_divisible_by=2:reset_sar=1,{frame}")
}

fn encode_clip(
    path: &Path,
    clip: Clip,
    filter: &str,
    destination: &Path,
    on_progress: impl Fn(f64),
) -> Result<()> {
    let mut cmd = ffmpeg();
    let duration = clip.end - clip.start;
    let log = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut read_log = log.try_clone().map_err(|error| error.to_string())?;
    cmd.args(["-ss", &format!("{:.6}", clip.start)]);
    input(&mut cmd, path)
        .args([
            "-t",
            &format!("{duration:.6}"),
            "-map",
            "0:V:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-vf",
            filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "19",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
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

#[tauri::command]
pub async fn export_clips(
    app: AppHandle,
    path: PathBuf,
    folder: PathBuf,
    mut clips: Vec<Clip>,
    format: Format,
    framing: Framing,
    progress: Channel<Progress>,
) -> Result<ExportResult> {
    background(move || {
        let video = probe(source(&path)?)?;
        validate_clips(&mut clips, video.duration)?;
        if !folder.is_absolute() || !folder.is_dir() {
            return Err("Choose an existing export folder.".into());
        }
        let filter = filter(format, framing);
        let stem: String = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .take(60)
            .collect();
        let total = clips.len();
        let mut files = Vec::with_capacity(total);
        for (index, clip) in clips.into_iter().enumerate() {
            let encode = || {
                let output = tempfile::Builder::new()
                    .prefix(".minividcut-")
                    .suffix(".mp4")
                    .tempfile_in(&folder)
                    .map_err(|error| format!("Could not write in this folder: {error}"))?;
                encode_clip(&video.path, clip, &filter, output.path(), |fraction| {
                    let _ = progress.send(Progress {
                        completed: index,
                        total,
                        fraction,
                    });
                })?;
                save_clip(output, &folder, &format!("{stem} - Clip {:02}", index + 1))
            };
            match encode() {
                Ok(path) => {
                    if files.is_empty() {
                        *app.state::<ExportFolder>()
                            .0
                            .lock()
                            .map_err(|error| error.to_string())? = Some(folder.clone());
                    }
                    files.push(path);
                }
                Err(error) => {
                    return Ok(ExportResult {
                        files,
                        error: Some(error),
                    })
                }
            }
            let _ = progress.send(Progress {
                completed: index + 1,
                total,
                fraction: 0.0,
            });
        }
        Ok(ExportResult { files, error: None })
    })
    .await
}

#[tauri::command]
pub fn open_export_folder(app: AppHandle) -> Result<()> {
    let folder = app
        .state::<ExportFolder>()
        .0
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
                &filter(format, framing),
                &path,
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
}
