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
const MODEL_BYTES: u64 = 739_508_576;
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
    allow_download: bool,
}

fn model_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("models").join(MODEL_FILE))
        .map_err(|error| error.to_string())
}

fn installed(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|file| file.is_file() && file.len() == MODEL_BYTES)
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
                    || start - cue.end > 0.5
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
        if samples.iter().any(|sample| sample.abs() > 0.0001) {
            samples.resize(samples.len().max(SAMPLE_RATE), 0.0);
            let transcript = session.run(&samples, &options);
            check_cancel(cancel)?;
            let transcript =
                transcript.map_err(|error| format!("Could not transcribe the audio: {error}"))?;
            append_cues(&mut cues, transcript.words, offset, length);
        }
        processed += size / 4;
        report(CaptionProgress::Transcribing {
            fraction: (processed as f64 / SAMPLE_RATE as f64 / duration).min(0.99),
        });
    }
    Ok(cues)
}

#[tauri::command]
pub async fn generate_captions(
    app: AppHandle,
    request: CaptionRequest,
    progress: Channel<CaptionProgress>,
) -> Result<Vec<Cue>> {
    let path = model_path(&app)?;
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
        report(CaptionProgress::Preparing);
        let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
        let pcm = directory.path().join("audio.pcm");
        let duration = caption_audio(&request.path, request.range, &pcm)?;
        check_cancel(cancel)?;
        let pcm = File::open(pcm).map_err(|error| error.to_string())?;
        if pcm.metadata().map_err(|error| error.to_string())?.len() == 0 {
            return Ok(Vec::new());
        }
        if !installed(&path) {
            tauri::async_runtime::block_on(download_model(&path, cancel, &report))?;
        }
        let mut session = lock(&engine.session)?;
        if session.is_none() {
            report(CaptionProgress::Loading);
            *session = Some(load_session(&path)?);
        }
        let session = session.as_mut().unwrap();
        report(CaptionProgress::Transcribing { fraction: 0.0 });
        let result = transcribe_audio(session, pcm, duration, cancel, &report);
        session.clear_cancel_token();
        check_cancel(cancel)?;
        result
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
