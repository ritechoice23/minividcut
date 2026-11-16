use crate::video::{self, Format, FramePosition, Framing, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const FPS: f64 = 30.0;
const MAX_TRANSITION_FRAMES: u32 = 15;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Transition {
    Cut,
    Fade,
    Slide,
}

#[derive(Deserialize)]
struct Bookend {
    path: PathBuf,
    transition: Transition,
    duration: Option<f64>,
    position: Option<FramePosition>,
}

#[derive(Default, Deserialize)]
pub struct Bookends {
    intro: Option<Bookend>,
    outro: Option<Bookend>,
}

#[derive(Clone)]
struct Segment {
    path: PathBuf,
    frames: u32,
    audio: bool,
    image: bool,
}

pub struct Assembly {
    intro: Option<PreparedBookend>,
    outro: Option<PreparedBookend>,
    source_audio: bool,
}

struct PreparedBookend {
    segment: Segment,
    transition: Transition,
    filter: String,
}

pub fn resolve(
    bookends: &Bookends,
    cache: &mut AssetCache,
    source_audio: bool,
    format: Format,
) -> Result<Option<Assembly>> {
    let mut resolve = |bookend: &Bookend| -> Result<PreparedBookend> {
        let segment = cache.0.entry(bookend.path.clone()).or_insert_with(|| {
            let image = is_image(&bookend.path);
            let (duration, audio) = if image {
                inspect_image(&bookend.path)?;
                (0.0, false)
            } else {
                let info = video::probe(video::source(&bookend.path)?)?;
                (info.duration, video::audio_stream(&bookend.path, None)?)
            };
            Ok(Segment {
                frames: frame_count(duration),
                audio,
                image,
                path: bookend.path.clone(),
            })
        });
        let mut segment = segment.clone()?;
        if segment.image {
            let duration = bookend.duration.unwrap_or(2.0);
            if !duration.is_finite() || !(0.5..=30.0).contains(&duration) {
                return Err("Image duration must be between 0.5 and 30 seconds.".into());
            }
            segment.frames = frame_count(duration);
        }
        let filter = video::filter(
            format,
            Framing::Fit,
            bookend.position.unwrap_or(FramePosition { x: 50, y: 50 }),
        )?;
        Ok(PreparedBookend {
            segment,
            transition: bookend.transition,
            filter,
        })
    };
    let intro = bookends.intro.as_ref().map(&mut resolve).transpose()?;
    let outro = bookends.outro.as_ref().map(resolve).transpose()?;
    Ok((intro.is_some() || outro.is_some()).then_some(Assembly {
        intro,
        outro,
        source_audio,
    }))
}

#[derive(Default)]
pub struct AssetCache(HashMap<PathBuf, Result<Segment>>);

impl Bookends {
    pub fn configured(&self) -> bool {
        self.intro.is_some() || self.outro.is_some()
    }
}

fn frame_count(seconds: f64) -> u32 {
    ((seconds * FPS).round() as u32).max(1)
}

fn seconds(frames: u32) -> f64 {
    f64::from(frames) / FPS
}

fn video_filter(input: &str, frames: u32, output: &str) -> String {
    format!("{input}fps=30,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=1,trim=end_frame={frames},settb=1/30,setpts=N[{output}]")
}

fn audio_filter(input: Option<&str>, frames: u32, output: &str) -> String {
    let duration = seconds(frames);
    match input {
        Some(input) => format!("{input}aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration={duration:.9},asetpts=PTS-STARTPTS[{output}]"),
        None => format!("anullsrc=r=48000:cl=stereo:d={duration:.9}[{output}]"),
    }
}

impl Assembly {
    pub fn append(
        &self,
        cmd: &mut Command,
        graph: &mut Vec<String>,
        mut index: usize,
        duration: f64,
        main_video: &str,
        mixed_music: bool,
    ) -> f64 {
        let main_frames = frame_count(duration);
        graph.push(video_filter(main_video, main_frames, "main_v"));
        let original = if mixed_music {
            Some("[mixed]")
        } else {
            self.source_audio.then_some("[0:a:0]")
        };
        graph.push(audio_filter(original, main_frames, "main_a"));

        let mut frames = main_frames;
        let mut video = "main_v";
        let mut audio = "main_a";
        if let Some(intro) = &self.intro {
            add_segment(cmd, graph, index, intro, "intro");
            index += 1;
            frames = join(
                graph,
                ("intro_v", "intro_a", intro.segment.frames),
                (video, audio, main_frames),
                intro.transition,
                overlap(intro.transition, intro.segment.frames, main_frames),
                ("joined_v", "joined_a"),
            );
            video = "joined_v";
            audio = "joined_a";
        }
        if let Some(outro) = &self.outro {
            add_segment(cmd, graph, index, outro, "outro");
            frames = join(
                graph,
                (video, audio, frames),
                ("outro_v", "outro_a", outro.segment.frames),
                outro.transition,
                overlap(outro.transition, main_frames, outro.segment.frames),
                ("final_v", "final_a"),
            );
        } else {
            graph.push(format!("[{video}]null[final_v]"));
            graph.push(format!("[{audio}]anull[final_a]"));
        }
        seconds(frames)
    }
}

fn add_segment(
    cmd: &mut Command,
    graph: &mut Vec<String>,
    index: usize,
    bookend: &PreparedBookend,
    name: &str,
) {
    let segment = &bookend.segment;
    cmd.args(["-threads:v", "1"]);
    if segment.image {
        cmd.args([
            "-f",
            "image2",
            "-pattern_type",
            "none",
            "-framerate",
            "30",
            "-format_whitelist",
            "image2",
        ]);
    }
    video::input(cmd, &segment.path);
    let fit = &bookend.filter;
    if segment.image {
        graph.push(format!("[{index}:v:0]trim=end_frame=1,{fit},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop={},settb=1/30,setpts=N[{name}_v]", segment.frames - 1));
    } else {
        graph.push(video_filter(
            &format!("[{index}:V:0]{fit},"),
            segment.frames,
            &format!("{name}_v"),
        ));
    }
    let input = format!("[{index}:a:0]");
    graph.push(audio_filter(
        segment.audio.then_some(input.as_str()),
        segment.frames,
        &format!("{name}_a"),
    ));
}

fn overlap(transition: Transition, first: u32, second: u32) -> u32 {
    match transition {
        Transition::Cut => 0,
        _ => MAX_TRANSITION_FRAMES.min(first / 2).min(second / 2),
    }
}

fn join(
    graph: &mut Vec<String>,
    first: (&str, &str, u32),
    second: (&str, &str, u32),
    transition: Transition,
    overlap: u32,
    outputs: (&str, &str),
) -> u32 {
    let (v1, a1, first_frames) = first;
    let (v2, a2, second_frames) = second;
    let (video, audio) = outputs;
    if overlap == 0 {
        graph.push(format!(
            "[{v1}][{v2}]concat=n=2:v=1:a=0,settb=1/30,setpts=N[{video}]"
        ));
        graph.push(format!("[{a1}][{a2}]concat=n=2:v=0:a=1[{audio}]"));
    } else {
        let effect = match transition {
            Transition::Slide => "slideleft",
            _ => "fade",
        };
        graph.push(format!("[{v1}][{v2}]xfade=transition={effect}:duration={:.9}:offset={:.9},settb=1/30,setpts=N[{video}]",
            seconds(overlap), seconds(first_frames - overlap)));
        graph.push(format!(
            "[{a1}][{a2}]acrossfade=ns={}[{audio}]",
            overlap * 1600
        ));
    }
    first_frames + second_frames - overlap
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["png", "jpg", "jpeg", "webp", "bmp"]
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

fn inspect_image(path: &Path) -> Result<()> {
    if !path.is_absolute() || !path.is_file() {
        return Err("Choose an existing image file.".into());
    }
    video::output(
        video::command("ffmpeg")
            .args([
                "-v",
                "error",
                "-nostdin",
                "-xerror",
                "-f",
                "image2",
                "-pattern_type",
                "none",
                "-format_whitelist",
                "image2",
            ])
            .args(["-protocol_whitelist", "file", "-i"])
            .arg(path)
            .args(["-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"]),
        "ffmpeg",
        "Could not read this image",
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct BookendInfo {
    image: bool,
    path: PathBuf,
    name: String,
    duration: f64,
}

#[tauri::command]
pub async fn inspect_bookend(app: AppHandle, path: PathBuf) -> Result<BookendInfo> {
    video::background(move || {
        let image = is_image(&path);
        let duration = if image {
            inspect_image(&path)?;
            app.asset_protocol_scope()
                .allow_file(&path)
                .map_err(|error| error.to_string())?;
            0.0
        } else {
            video::probe(video::source(&path)?)?.duration
        };
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        Ok(BookendInfo { image, path, name, duration })
    })
    .await
}
