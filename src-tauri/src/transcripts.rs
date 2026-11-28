//! Remembers which parts of a video have been transcribed, on disk, so the
//! speech model never listens to the same footage twice. Find clips, clip
//! captions, titles and the timeline all read from the same saved spans, and
//! they survive restarting the app.
//!
//! A saved transcript belongs to one video file (path, size, modified time and
//! length) and one speech model, so replacing the file or the model starts fresh.

use crate::caption_render::{Cue, TimedWord};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;

const VERSION: u32 = 1;
/// Uncovered stretches shorter than this are rounding, not footage to listen to.
const MIN_GAP: f64 = 0.75;
/// Spans that touch (within this) are joined into one.
const JOIN: f64 = 0.02;
const KEEP_FILES: usize = 60;

/// A stretch of the video that has been transcribed. Cue times are in video time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Span {
    pub start: f64,
    pub end: f64,
    pub cues: Vec<Cue>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Transcript {
    version: u32,
    spans: Vec<Span>,
}

impl Default for Transcript {
    fn default() -> Self {
        Transcript {
            version: VERSION,
            spans: Vec::new(),
        }
    }
}

fn clip_cue(cue: &Cue, start: f64, end: f64) -> Option<Cue> {
    let middle = (cue.start + cue.end) / 2.0;
    if middle < start || middle >= end {
        return None;
    }
    let words: Vec<TimedWord> = cue
        .words
        .iter()
        .filter(|word| {
            let middle = (word.start + word.end) / 2.0;
            middle >= start && middle < end
        })
        .map(|word| TimedWord {
            start: word.start.max(start) - start,
            end: word.end.min(end) - start,
            text: word.text.clone(),
        })
        .collect();
    let text = if cue.words.is_empty() || words.len() == cue.words.len() {
        cue.text.clone()
    } else {
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let (from, to) = (cue.start.max(start) - start, cue.end.min(end) - start);
    (to > from && !text.trim().is_empty()).then_some(Cue {
        start: from,
        end: to,
        text,
        words,
    })
}

/// Moves cues from a stretch's own clock into video time.
pub fn shifted(cues: Vec<Cue>, by: f64) -> Vec<Cue> {
    cues.into_iter()
        .map(|mut cue| {
            cue.start += by;
            cue.end += by;
            for word in &mut cue.words {
                word.start += by;
                word.end += by;
            }
            cue
        })
        .collect()
}

impl Transcript {
    /// The stretches of `start..end` that still need transcribing.
    pub fn missing(&self, start: f64, end: f64) -> Vec<(f64, f64)> {
        let mut gaps = Vec::new();
        let mut at = start;
        for span in &self.spans {
            if span.end <= at {
                continue;
            }
            if span.start >= end {
                break;
            }
            if span.start - at >= MIN_GAP {
                gaps.push((at, span.start));
            }
            at = at.max(span.end);
            if at >= end {
                break;
            }
        }
        if end - at >= MIN_GAP {
            gaps.push((at, end));
        }
        gaps
    }

    /// Remembers a transcribed stretch, joining it to its neighbours.
    pub fn add(&mut self, span: Span) {
        if !span.start.is_finite() || !span.end.is_finite() || span.end <= span.start {
            return;
        }
        self.spans.push(span);
        self.spans.sort_by(|a, b| a.start.total_cmp(&b.start));
        let mut joined: Vec<Span> = Vec::with_capacity(self.spans.len());
        for span in self.spans.drain(..) {
            match joined.last_mut() {
                Some(last) if span.start <= last.end + JOIN => {
                    last.end = last.end.max(span.end);
                    last.cues.extend(span.cues);
                }
                _ => joined.push(span),
            }
        }
        for span in &mut joined {
            span.cues.sort_by(|a, b| a.start.total_cmp(&b.start));
            // Overlapping requests can both have heard the same words.
            span.cues
                .dedup_by(|b, a| (a.start - b.start).abs() < 0.05 && a.text == b.text);
        }
        self.spans = joined;
    }

    /// The cues inside `start..end`, timed from `start` like a fresh transcript of that range.
    pub fn cues_in(&self, start: f64, end: f64) -> Vec<Cue> {
        self.spans
            .iter()
            .filter(|span| span.end > start && span.start < end)
            .flat_map(|span| span.cues.iter().filter_map(|cue| clip_cue(cue, start, end)))
            .collect()
    }

    fn valid(&self) -> bool {
        self.version == VERSION
            && self
                .spans
                .iter()
                .all(|span| span.start.is_finite() && span.end.is_finite() && span.end > span.start)
    }
}

/// Identifies one video file and speech model.
pub fn key(path: &Path, duration: f64, model: &str) -> Option<String> {
    let info = fs::metadata(path).ok()?;
    let modified = info
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    let id = format!(
        "{}|{}|{}|{:.2}|{}|{}",
        path.to_string_lossy().to_lowercase(),
        info.len(),
        modified,
        duration,
        model,
        VERSION
    );
    let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
    Some(digest[..32].to_owned())
}

pub fn directory(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("transcripts"))
        .map_err(|error| error.to_string())
}

fn files(dir: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let info = entry.metadata().ok()?;
            info.is_file().then(|| {
                (
                    entry.path(),
                    info.len(),
                    info.modified().unwrap_or(UNIX_EPOCH),
                )
            })
        })
        .collect()
}

/// A missing, unreadable or outdated file is the same as nothing saved yet.
pub fn load(dir: &Path, key: &str) -> Transcript {
    fs::read(dir.join(format!("{key}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Transcript>(&bytes).ok())
        .filter(Transcript::valid)
        .unwrap_or_default()
}

pub fn save(dir: &Path, key: &str, transcript: &Transcript) -> Result<()> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(transcript).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.persist(dir.join(format!("{key}.json")))
        .map_err(|error| error.to_string())?;
    prune(dir);
    Ok(())
}

/// Keeps the folder from growing without bound: the oldest videos go first.
fn prune(dir: &Path) {
    let mut saved = files(dir);
    if saved.len() <= KEEP_FILES {
        return;
    }
    saved.sort_by_key(|(_, _, modified)| *modified);
    for (path, _, _) in saved.iter().take(saved.len() - KEEP_FILES) {
        let _ = fs::remove_file(path);
    }
}

#[tauri::command]
pub fn transcript_cache_bytes(app: AppHandle) -> Result<u64> {
    Ok(files(&directory(&app)?)
        .iter()
        .map(|(_, bytes, _)| bytes)
        .sum())
}

/// Forgets every saved transcript. Only the saved transcript files are removed.
#[tauri::command]
pub fn clear_transcript_cache(app: AppHandle) -> Result<()> {
    for (path, _, _) in files(&directory(&app)?) {
        fs::remove_file(path).map_err(|_| {
            "MiniVidCut couldn’t clear the saved transcripts. Try again.".to_string()
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(start: f64, end: f64, text: &str) -> TimedWord {
        TimedWord {
            start,
            end,
            text: text.into(),
        }
    }

    fn cue(start: f64, end: f64, text: &str) -> Cue {
        let words = text
            .split_whitespace()
            .enumerate()
            .map(|(index, token)| {
                let step = (end - start) / text.split_whitespace().count() as f64;
                word(
                    start + step * index as f64,
                    start + step * (index + 1) as f64,
                    token,
                )
            })
            .collect();
        Cue {
            start,
            end,
            text: text.into(),
            words,
        }
    }

    fn span(start: f64, end: f64, cues: Vec<Cue>) -> Span {
        Span { start, end, cues }
    }

    #[test]
    fn only_untranscribed_stretches_are_missing() {
        let mut transcript = Transcript::default();
        assert_eq!(transcript.missing(0.0, 100.0), vec![(0.0, 100.0)]);
        transcript.add(span(10.0, 40.0, vec![]));
        transcript.add(span(60.0, 80.0, vec![]));
        assert_eq!(
            transcript.missing(0.0, 100.0),
            vec![(0.0, 10.0), (40.0, 60.0), (80.0, 100.0)]
        );
        assert_eq!(transcript.missing(15.0, 35.0), Vec::<(f64, f64)>::new());
        assert_eq!(transcript.missing(30.0, 70.0), vec![(40.0, 60.0)]);
    }

    #[test]
    fn rounding_slivers_are_not_worth_listening_to() {
        let mut transcript = Transcript::default();
        transcript.add(span(0.0, 29.9, vec![]));
        assert!(transcript.missing(0.0, 30.0).is_empty());
        transcript.add(span(30.4, 60.0, vec![]));
        assert!(transcript.missing(0.0, 60.0).is_empty());
        assert_eq!(transcript.missing(0.0, 62.0), vec![(60.0, 62.0)]);
    }

    #[test]
    fn touching_and_overlapping_spans_join_without_duplicate_cues() {
        let mut transcript = Transcript::default();
        transcript.add(span(
            0.0,
            30.0,
            vec![
                cue(1.0, 3.0, "hello there"),
                cue(20.0, 25.0, "shared words"),
            ],
        ));
        transcript.add(span(60.0, 90.0, vec![cue(61.0, 63.0, "later on")]));
        transcript.add(span(
            20.0,
            60.0,
            vec![
                cue(20.0, 25.0, "shared words"),
                cue(40.0, 45.0, "middle part"),
            ],
        ));
        assert_eq!(transcript.spans.len(), 1);
        assert_eq!(
            (transcript.spans[0].start, transcript.spans[0].end),
            (0.0, 90.0)
        );
        let texts: Vec<_> = transcript.spans[0]
            .cues
            .iter()
            .map(|cue| cue.text.as_str())
            .collect();
        assert_eq!(
            texts,
            ["hello there", "shared words", "middle part", "later on"]
        );
        assert!(transcript.missing(0.0, 90.0).is_empty());
    }

    #[test]
    fn a_range_is_assembled_from_saved_cues_and_timed_from_its_start() {
        let mut transcript = Transcript::default();
        transcript.add(span(
            0.0,
            60.0,
            vec![
                cue(10.0, 14.0, "one two three four"),
                cue(30.0, 34.0, "five six"),
            ],
        ));
        let cues = transcript.cues_in(8.0, 20.0);
        assert_eq!(cues.len(), 1);
        assert_eq!((cues[0].start, cues[0].end), (2.0, 6.0));
        assert_eq!(cues[0].words[0].start, 2.0);
        assert_eq!(cues[0].text, "one two three four");
        assert!(transcript.cues_in(40.0, 50.0).is_empty());
    }

    #[test]
    fn a_cue_cut_by_the_range_keeps_only_the_words_inside_it() {
        let mut transcript = Transcript::default();
        transcript.add(span(0.0, 60.0, vec![cue(10.0, 18.0, "a b c d e f g h")]));
        // The cue's midpoint (14s) is inside 10..15, so it belongs here, trimmed to that range.
        let cues = transcript.cues_in(10.0, 15.0);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "a b c d e");
        assert_eq!(cues[0].end, 5.0);
        assert!(cues[0].words.iter().all(|word| word.end <= 5.0));
        // Exactly on the edge it goes to the later range, never to both.
        assert!(transcript.cues_in(10.0, 14.0).is_empty());
        assert_eq!(transcript.cues_in(14.0, 20.0).len(), 1);
        // A cue that merely overlaps the edge belongs to the neighbour that holds most of it.
        assert!(transcript.cues_in(17.0, 30.0).is_empty());
    }

    #[test]
    fn shifting_moves_words_with_their_cue() {
        let shifted = shifted(vec![cue(1.0, 3.0, "hi there")], 100.0);
        assert_eq!((shifted[0].start, shifted[0].end), (101.0, 103.0));
        assert_eq!(shifted[0].words[0].start, 101.0);
        assert_eq!(shifted[0].words[1].end, 103.0);
    }

    #[test]
    fn saved_transcripts_survive_a_restart_and_bad_files_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let mut transcript = Transcript::default();
        transcript.add(span(0.0, 30.0, vec![cue(1.0, 3.0, "hello there")]));
        save(dir.path(), "abc", &transcript).unwrap();
        assert_eq!(load(dir.path(), "abc"), transcript);
        assert_eq!(load(dir.path(), "other"), Transcript::default());
        fs::write(dir.path().join("broken.json"), b"{not json").unwrap();
        assert_eq!(load(dir.path(), "broken"), Transcript::default());
        fs::write(dir.path().join("old.json"), br#"{"version":0,"spans":[]}"#).unwrap();
        assert_eq!(load(dir.path(), "old"), Transcript::default());
        fs::write(
            dir.path().join("bad.json"),
            br#"{"version":1,"spans":[{"start":5.0,"end":2.0,"cues":[]}]}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path(), "bad"), Transcript::default());
    }

    #[test]
    fn a_video_is_identified_by_its_file_length_and_model() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Talk.mp4");
        fs::write(&video, b"12345").unwrap();
        let first = key(&video, 60.0, "model-a").unwrap();
        assert_eq!(first, key(&video, 60.0, "model-a").unwrap());
        assert_eq!(first.len(), 32);
        assert_ne!(first, key(&video, 61.0, "model-a").unwrap());
        assert_ne!(first, key(&video, 60.0, "model-b").unwrap());
        fs::write(&video, b"123456").unwrap();
        assert_ne!(first, key(&video, 60.0, "model-a").unwrap());
        assert_eq!(key(&dir.path().join("missing.mp4"), 60.0, "model-a"), None);
    }

    #[test]
    fn only_the_newest_transcripts_are_kept_and_clearing_touches_only_json() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("keep.txt"), b"not a transcript").unwrap();
        for index in 0..KEEP_FILES + 5 {
            fs::write(dir.path().join(format!("old{index}.json")), b"{}").unwrap();
        }
        let transcript = Transcript::default();
        save(dir.path(), "newest", &transcript).unwrap();
        assert_eq!(files(dir.path()).len(), KEEP_FILES);
        assert!(dir.path().join("newest.json").is_file());
        assert!(dir.path().join("keep.txt").is_file());
        for (path, _, _) in files(dir.path()) {
            fs::remove_file(path).unwrap();
        }
        assert!(dir.path().join("keep.txt").is_file());
        assert!(files(dir.path()).is_empty());
    }
}
