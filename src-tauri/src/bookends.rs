use crate::video::{self, Result};
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
};

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
}

pub struct Assembly {
    intro: Option<(Segment, Transition)>,
    outro: Option<(Segment, Transition)>,
    source_audio: bool,
}

pub fn resolve(
    bookends: &Bookends,
    cache: &mut AssetCache,
    source_audio: bool,
) -> Result<Option<Assembly>> {
    let mut resolve = |bookend: &Bookend| {
        let segment = cache.0.entry(bookend.path.clone()).or_insert_with(|| {
            let info = video::probe(video::source(&bookend.path)?)?;
            Ok(Segment {
                frames: frame_count(info.duration),
                audio: video::audio_stream(&bookend.path, None)?,
                path: bookend.path.clone(),
            })
        });
        segment.clone().map(|segment| (segment, bookend.transition))
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
        fit: &str,
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
        if let Some((intro, transition)) = &self.intro {
            add_segment(cmd, graph, index, intro, fit, "intro");
            index += 1;
            frames = join(
                graph,
                ("intro_v", "intro_a", intro.frames),
                (video, audio, main_frames),
                *transition,
                overlap(*transition, intro.frames, main_frames),
                ("joined_v", "joined_a"),
            );
            video = "joined_v";
            audio = "joined_a";
        }
        if let Some((outro, transition)) = &self.outro {
            add_segment(cmd, graph, index, outro, fit, "outro");
            frames = join(
                graph,
                (video, audio, frames),
                ("outro_v", "outro_a", outro.frames),
                *transition,
                overlap(*transition, main_frames, outro.frames),
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
    segment: &Segment,
    fit: &str,
    name: &str,
) {
    cmd.args(["-threads:v", "1"]);
    video::input(cmd, &segment.path);
    graph.push(video_filter(
        &format!("[{index}:V:0]{fit},"),
        segment.frames,
        &format!("{name}_v"),
    ));
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

#[tauri::command]
pub async fn inspect_bookend(path: PathBuf) -> Result<video::VideoInfo> {
    video::background(move || video::probe(video::source(Path::new(&path))?)).await
}
