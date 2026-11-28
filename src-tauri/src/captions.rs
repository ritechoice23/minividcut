use crate::{
    caption_render::{Cue, TimedWord},
    video::{background, caption_audio, Clip},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager};
use transcribe_cpp::{
    CancelToken, Model, RunOptions, Session, SessionOptions, TimestampKind, Word,
};

type Result<T> = std::result::Result<T, String>;
const MODEL_FILE: &str = "parakeet-tdt-0.6b-v3-Q8_0.gguf";
pub(crate) const MODEL_BYTES: u64 = 739_508_576;
const MODEL_SHA256: &str = "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7";
const MODEL_URL: &str = concat!(
    "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/",
    "85ac09ea12fc4b1112fa76810059364bc6adc9de/parakeet-tdt-0.6b-v3-Q8_0.gguf"
);
const SAMPLE_RATE: usize = 16_000;
const CHUNK_SAMPLES: usize = 30 * SAMPLE_RATE;
const CANCELLED: &str = "Caption generation canceled.";

#[derive(Default)]
pub struct CaptionEngine {
    session: Mutex<Option<Session>>,
    job: Mutex<Option<CancelToken>>,
}

struct Job<'a> {
    active: &'a Mutex<Option<CancelToken>>,
    cancel: CancelToken,
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "The caption engine needs to be restarted.".into())
}

impl CaptionEngine {
    fn begin(&self) -> Result<Job<'_>> {
        let mut active = lock(&self.job)?;
        if active.is_some() {
            return Err("Caption generation is already running.".into());
        }
        let cancel = CancelToken::new();
        *active = Some(cancel.clone());
        Ok(Job {
            active: &self.job,
            cancel,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionModel {
    installed: bool,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum CaptionProgress {
    Preparing,
    Downloading { fraction: f64 },
    Loading,
    Transcribing { fraction: f64 },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionRequest {
    path: PathBuf,
    range: Clip,
    duration: f64,
    allow_download: bool,
}

pub(crate) fn model_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("models").join(MODEL_FILE))
        .map_err(|error| error.to_string())
}

pub(crate) fn installed(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|file| file.is_file() && file.len() == MODEL_BYTES)
}

pub(crate) async fn manage_model(
    app: AppHandle,
    install: bool,
    progress: Channel<String>,
) -> Result<()> {
    let path = model_path(&app)?;
    background(move || {
        let engine = app.state::<CaptionEngine>();
        let job = engine
            .begin()
            .map_err(|_| "Wait for captioning to finish and try again.")?;
        if install {
            if !installed(&path) {
                tauri::async_runtime::block_on(download_model(&path, &job.cancel, &|stage| {
                    if let CaptionProgress::Downloading { fraction } = stage {
                        let _ =
                            progress.send(format!("Downloading • {}%", (fraction * 100.0).floor()));
                    }
                }))?;
            }
        } else {
            *lock(&engine.session)? = None;
            crate::models::remove_file(&path)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn caption_model(app: AppHandle) -> Result<CaptionModel> {
    let path = model_path(&app)?;
    background(move || {
        Ok(CaptionModel {
            installed: installed(&path),
            bytes: MODEL_BYTES,
        })
    })
    .await
}

#[tauri::command]
pub fn cancel_captions(app: AppHandle) -> Result<()> {
    if let Some(cancel) = lock(&app.state::<CaptionEngine>().job)?.as_ref() {
        cancel.cancel();
    }
    Ok(())
}

fn check_cancel(cancel: &CancelToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

async fn download_model(
    path: &Path,
    cancel: &CancelToken,
    report: &impl Fn(CaptionProgress),
) -> Result<()> {
    let directory = path.parent().ok_or("Could not find the model folder.")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the model folder: {error}"))?;
    let mut file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("Could not save the model: {error}"))?;
    report(CaptionProgress::Downloading { fraction: 0.0 });
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| {
            format!(
                "Could not start the model download: {}",
                error.without_url()
            )
        })?;
    let mut response = client
        .get(MODEL_URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| {
            format!(
                "Could not download the caption model: {}",
                error.without_url()
            )
        })?;
    let mut digest = Sha256::new();
    let mut bytes = 0;
    let mut last_update = Instant::now();
    loop {
        check_cancel(cancel)?;
        let Some(chunk) = response.chunk().await.map_err(|error| {
            format!(
                "The model download was interrupted: {}",
                error.without_url()
            )
        })?
        else {
            break;
        };
        bytes += chunk.len() as u64;
        if bytes > MODEL_BYTES {
            return Err("The model download exceeded its expected size.".into());
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .map_err(|error| format!("Could not save the model: {error}"))?;
        if last_update.elapsed() >= Duration::from_millis(100) {
            report(CaptionProgress::Downloading {
                fraction: bytes as f64 / MODEL_BYTES as f64,
            });
            last_update = Instant::now();
        }
    }
    if bytes != MODEL_BYTES || format!("{:x}", digest.finalize()) != MODEL_SHA256 {
        return Err("The model download could not be verified. Try downloading it again.".into());
    }
    check_cancel(cancel)?;
    file.as_file()
        .sync_all()
        .map_err(|error| format!("Could not save the model: {error}"))?;
    file.persist(path)
        .map_err(|error| format!("Could not install the model: {error}"))?;
    Ok(())
}

fn load_session(path: &Path) -> Result<Session> {
    let threads = std::thread::available_parallelism().map_or(1, usize::from);
    let model =
        Model::load(path).map_err(|error| format!("Could not open the caption model: {error}"))?;
    model
        .session_with(&SessionOptions {
            n_threads: (threads / 2).clamp(1, 6) as i32,
            ..Default::default()
        })
        .map_err(|error| format!("Could not start the caption model: {error}"))
}

// Group timed words into brief phrases. Keep pauses visible in playback.
fn append_cues(cues: &mut Vec<Cue>, words: Vec<Word>, offset: f64, duration: f64) {
    let mut phrase: Option<Cue> = None;
    for word in words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }
        let start = offset + (word.t0_ms as f64 / 1000.0).clamp(0.0, duration);
        let end = offset + (word.t1_ms as f64 / 1000.0).clamp(0.0, duration);
        if start >= offset + duration {
            continue;
        }
        let punctuation = matches!(
            text,
            "." | "," | "!" | "?" | ":" | ";" | "…" | "。" | "！" | "？"
        );
        if phrase.as_ref().is_some_and(|cue| {
            !punctuation
                && (cue.text.ends_with(['.', '!', '?', '…', '。', '！', '？'])
                    || start - cue.end >= 0.27
                    || end - cue.start > 3.2
                    || cue.text.chars().count() + text.chars().count() > 44)
        }) {
            let mut cue = phrase.take().unwrap();
            cue.end = cue.end.min(start);
            if cue.end > cue.start {
                cues.push(cue);
            }
        }
        let previous_end = cues.last().map_or(start, |cue| cue.end.max(start));
        let cue = phrase.get_or_insert_with(|| Cue {
            start: previous_end,
            end: previous_end,
            text: String::new(),
            words: Vec::new(),
        });
        if !cue.text.is_empty() && !punctuation {
            cue.text.push(' ');
        }
        cue.text.push_str(text);
        if punctuation {
            if let Some(word) = cue.words.last_mut() {
                word.text.push_str(text);
            }
        } else {
            for token in text.split_whitespace() {
                cue.words.push(TimedWord {
                    start: start.max(cue.start),
                    end: end.max(start + 0.04).min(offset + duration),
                    text: token.into(),
                });
            }
        }
        cue.end = cue
            .end
            .max(end.max(cue.start + 0.12).min(offset + duration));
    }
    if let Some(cue) = phrase.filter(|cue| cue.end > cue.start) {
        cues.push(cue);
    }
}

fn transcribe_audio(
    session: &mut Session,
    mut pcm: File,
    duration: f64,
    cancel: &CancelToken,
    report: &impl Fn(CaptionProgress),
) -> Result<Vec<Cue>> {
    let options = RunOptions {
        timestamps: TimestampKind::Word,
        ..Default::default()
    };
    let mut bytes = vec![0; CHUNK_SAMPLES * 4];
    let mut samples = Vec::with_capacity(CHUNK_SAMPLES);
    let mut processed = 0;
    let mut cues = Vec::new();
    session.set_cancel_token(cancel);
    loop {
        check_cancel(cancel)?;
        let mut size = 0;
        while size < bytes.len() {
            let count = pcm
                .read(&mut bytes[size..])
                .map_err(|error| format!("Could not read the prepared audio: {error}"))?;
            if count == 0 {
                break;
            }
            size += count;
        }
        if size == 0 {
            break;
        }
        if size % 4 != 0 {
            return Err("The prepared audio is incomplete.".into());
        }
        samples.clear();
        samples.extend(
            bytes[..size]
                .chunks_exact(4)
                .map(|sample| f32::from_le_bytes(sample.try_into().unwrap())),
        );
        let offset = processed as f64 / SAMPLE_RATE as f64;
        let length = (samples.len() as f64 / SAMPLE_RATE as f64).min(duration - offset);
        if length <= 0.0 {
            break;
        }
        let audible = audible_ranges(&samples);
        if let Some(&(_, last)) = audible.last() {
            samples.resize(samples.len().max(SAMPLE_RATE), 0.0);
            let transcript = session.run(&samples, &options);
            check_cancel(cancel)?;
            let transcript =
                transcript.map_err(|error| format!("Could not transcribe the audio: {error}"))?;
            let words = align_to_audio(transcript.words, &audible);
            append_cues(&mut cues, words, offset, length.min(last as f64 / 1000.0));
        }
        processed += size / 4;
        report(CaptionProgress::Transcribing {
            fraction: (processed as f64 / SAMPLE_RATE as f64 / duration).min(0.99),
        });
    }
    Ok(cues)
}

fn audible_ranges(samples: &[f32]) -> Vec<(i64, i64)> {
    const WINDOW: usize = SAMPLE_RATE / 100;
    const PAUSE_MS: i64 = 280;
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    for (index, window) in samples.chunks(WINDOW).enumerate() {
        if window.iter().map(|sample| sample * sample).sum::<f32>()
            <= window.len() as f32 * 0.000_000_25
        {
            continue;
        }
        let start = index as i64 * 10;
        let end = start + (window.len() * 1000 / SAMPLE_RATE) as i64;
        if let Some((_, previous_end)) =
            ranges.last_mut().filter(|(_, end)| start - *end < PAUSE_MS)
        {
            *previous_end = end;
        } else {
            ranges.push((start, end));
        }
    }
    ranges
}

fn align_to_audio(words: Vec<Word>, audible: &[(i64, i64)]) -> Vec<Word> {
    words
        .into_iter()
        .filter_map(|mut word| {
            let (start, end) = audible
                .iter()
                .map(|&(start, end)| (start.max(word.t0_ms), end.min(word.t1_ms)))
                .max_by_key(|&(start, end)| end - start)?;
            if end <= start {
                // Some model punctuation has no duration. Keep it with the
                // preceding word without restoring text in a silent interval.
                return (word.t0_ms == word.t1_ms
                    && word.text.chars().all(|ch| !ch.is_alphanumeric()))
                .then_some(word);
            }
            word.t0_ms = start;
            word.t1_ms = end;
            Some(word)
        })
        .collect()
}

/// Transcribes one stretch of the video. Cue times start at zero for the stretch.
/// Returns the cues and how much audio there really was.
fn transcribe_stretch(
    engine: &CaptionEngine,
    model: &Path,
    source: &Path,
    video_duration: f64,
    range: Clip,
    cancel: &CancelToken,
    report: &impl Fn(CaptionProgress),
) -> Result<(Vec<Cue>, f64)> {
    report(CaptionProgress::Preparing);
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let pcm = directory.path().join("audio.pcm");
    let duration = caption_audio(source, range, video_duration, &pcm)?;
    check_cancel(cancel)?;
    let pcm = File::open(pcm).map_err(|error| error.to_string())?;
    if pcm.metadata().map_err(|error| error.to_string())?.len() == 0 {
        return Ok((Vec::new(), duration));
    }
    if !installed(model) {
        tauri::async_runtime::block_on(download_model(model, cancel, report))?;
    }
    let mut session = lock(&engine.session)?;
    if session.is_none() {
        report(CaptionProgress::Loading);
        *session = Some(load_session(model)?);
    }
    let session = session.as_mut().unwrap();
    report(CaptionProgress::Transcribing { fraction: 0.0 });
    let result = transcribe_audio(session, pcm, duration, cancel, report);
    session.clear_cancel_token();
    check_cancel(cancel)?;
    result.map(|cues| (cues, duration))
}

/// Captions, titles, Find clips and the timeline all come through here. What
/// has been transcribed before is read from the saved transcript for this
/// video; only the stretches not heard yet go to the speech model, and each is
/// saved as soon as it finishes so stopping never loses finished work.
#[tauri::command]
pub async fn generate_captions(
    app: AppHandle,
    request: CaptionRequest,
    progress: Channel<CaptionProgress>,
) -> Result<Vec<Cue>> {
    let path = model_path(&app)?;
    let cache_dir = crate::transcripts::directory(&app)?;
    background(move || {
        let engine = app.state::<CaptionEngine>();
        let job = engine.begin()?;
        let cancel = &job.cancel;
        let report = |stage| {
            let _ = progress.send(stage);
        };
        if !installed(&path) && !request.allow_download {
            return Err("Download the caption model to generate captions.".into());
        }
        if !request.duration.is_finite() || request.duration <= 0.0 {
            return Err("Invalid video duration.".into());
        }
        let from = request.range.start.max(0.0);
        let to = request.range.end.min(request.duration);
        let key = crate::transcripts::key(&request.path, request.duration, MODEL_FILE)
            .filter(|_| from.is_finite() && to.is_finite() && to > from);
        let Some(key) = key else {
            // Nothing to key the saved transcript on, so just transcribe the range.
            let (cues, _) = transcribe_stretch(
                &engine, &path, &request.path, request.duration, request.range, cancel, &report,
            )?;
            return Ok(cues);
        };
        let mut transcript = crate::transcripts::load(&cache_dir, &key);
        let gaps = transcript.missing(from, to);
        let total: f64 = gaps.iter().map(|(start, end)| end - start).sum::<f64>().max(0.001);
        let mut done = 0.0;
        if gaps.is_empty() {
            report(CaptionProgress::Transcribing { fraction: 0.99 });
        }
        for (start, end) in gaps {
            check_cancel(cancel)?;
            let length = end - start;
            let before = done;
            let report_stretch = |stage: CaptionProgress| match stage {
                CaptionProgress::Transcribing { fraction } => report(CaptionProgress::Transcribing {
                    fraction: ((before + fraction * length) / total).min(0.99),
                }),
                other => report(other),
            };
            let (cues, heard) = transcribe_stretch(
                &engine, &path, &request.path, request.duration, Clip { start, end }, cancel, &report_stretch,
            )?;
            transcript.add(crate::transcripts::Span {
                start,
                end: start + heard.min(length).max(0.0),
                cues: crate::transcripts::shifted(cues, start),
            });
            // A failed save only means this stretch is heard again next time.
            let _ = crate::transcripts::save(&cache_dir, &key, &transcript);
            done += length;
        }
        Ok(transcript.cues_in(from, to))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::{probe, source};

    #[test]
    fn preserves_silent_gaps_and_clamps_early_word_boundaries() {
        let mut samples = vec![0.0; SAMPLE_RATE];
        samples[1600..3200].fill(0.05);
        samples[8000..11200].fill(0.05);
        let audible = audible_ranges(&samples);
        assert_eq!(audible, vec![(100, 200), (500, 700)]);
        let words = [
            (70, 190, "First"),
            (210, 450, "noise"),
            (470, 740, "second"),
        ]
        .into_iter()
        .map(|(t0_ms, t1_ms, text)| Word {
            t0_ms,
            t1_ms,
            text: text.into(),
            ..Default::default()
        })
        .collect();
        let words = align_to_audio(words, &audible);
        assert_eq!(
            words
                .iter()
                .map(|word| (word.t0_ms, word.t1_ms))
                .collect::<Vec<_>>(),
            [(100, 190), (500, 700)]
        );
        let mut cues = Vec::new();
        append_cues(&mut cues, words, 0.0, 1.0);
        assert_eq!(cues.len(), 2);
        assert!(cues[0].end < cues[1].start);
        assert!(audible_ranges(&[0.0; 160]).is_empty());
    }

    #[test]
    fn groups_words_at_pauses_and_keeps_shot_offsets() {
        let words = [
            (20, 200, "Hello"),
            (220, 410, "there."),
            (1100, 1400, "Welcome"),
        ]
        .into_iter()
        .map(|(t0_ms, t1_ms, text)| Word {
            t0_ms,
            t1_ms,
            text: text.into(),
            ..Default::default()
        })
        .collect();
        let mut cues = Vec::new();
        append_cues(&mut cues, words, 30.0, 1.3);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].words.len(), 2);
        assert_eq!(cues[0].words[1].text, "there.");
        assert_eq!(cues[0].words[1].start, 30.22);
        assert_eq!(
            (&*cues[0].text, cues[0].start, cues[0].end),
            ("Hello there.", 30.02, 30.41)
        );
        assert_eq!(
            (&*cues[1].text, cues[1].start, cues[1].end),
            ("Welcome", 31.1, 31.3)
        );
    }

    #[test]
    #[ignore = "downloads the speech model and uses a spoken MP4 fixture"]
    fn downloads_and_transcribes_a_spoken_shot() {
        let input = PathBuf::from(
            std::env::var_os("MINIVIDCUT_CAPTION_FIXTURE").expect("set a path to a spoken MP4"),
        );
        let directory = tempfile::tempdir().unwrap();
        let model = std::env::var_os("MINIVIDCUT_CAPTION_TEST_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.path().join(MODEL_FILE));
        let pcm = directory.path().join("audio.pcm");
        let duration = caption_audio(
            &input,
            Clip {
                start: 0.2,
                end: 4.0,
            },
            probe(source(&input).unwrap()).unwrap().duration,
            &pcm,
        )
        .unwrap();
        let cancel = CancelToken::new();
        if !installed(&model) {
            tauri::async_runtime::block_on(download_model(&model, &cancel, &|_| {})).unwrap();
        }
        assert!(installed(&model));
        let started = Instant::now();
        let mut session = load_session(&model).unwrap();
        eprintln!("Cold model load: {:.2?}", started.elapsed());
        for _ in 0..2 {
            let started = Instant::now();
            let cues = transcribe_audio(
                &mut session,
                File::open(&pcm).unwrap(),
                duration,
                &cancel,
                &|_| {},
            )
            .unwrap();
            assert!(!cues.is_empty());
            assert!(cues.iter().map(|cue| cue.words.len()).sum::<usize>() > cues.len());
            assert!(cues
                .iter()
                .all(|cue| cue.start >= 0.0 && cue.end <= duration && cue.end > cue.start));
            let transcript = cues
                .iter()
                .map(|cue| cue.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            assert!(
                transcript.to_lowercase().contains("caption")
                    || transcript.to_lowercase().contains("welcome"),
                "{transcript}"
            );
            eprintln!(
                "{duration:.1}s shot in {:.2?}: {transcript}",
                started.elapsed()
            );
        }
    }
}
