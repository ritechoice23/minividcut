use crate::video::{self, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};

const BASE: &str = "https://kaino.dev";
const DOWNLOAD_HOST: &str = "a3abcd2451736f6a3867db58e7c8ec05.r2.cloudflarestorage.com";
const MAX_AUDIO: usize = 32 * 1024 * 1024;
const NETWORK_ATTEMPTS: u8 = 3;
// Auditions are a short, partial fetch kept apart from the downloaded library.
const PREVIEW_BYTES: usize = 512 * 1024;
const PREVIEW_MIN_BYTES: usize = 4 * 1024;
const PREVIEW_DIR: &str = ".previews";
const CANCELLED: &str = "Download canceled.";

#[derive(Default)]
pub struct DownloadCancels {
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadCancels {
    fn begin(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(id.to_owned(), Arc::clone(&flag));
        }
        flag
    }

    fn cancel(&self, id: &str) {
        if let Ok(jobs) = self.jobs.lock() {
            if let Some(flag) = jobs.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    fn finish(&self, id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(id);
        }
    }
}

struct CancelGuard<'a> {
    cancels: &'a DownloadCancels,
    id: String,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.cancels.finish(&self.id);
    }
}

#[tauri::command]
pub fn cancel_kaino(id: String, cancels: State<'_, DownloadCancels>) -> Result<()> {
    cancels.cancel(&id);
    Ok(())
}

fn check_cancel(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::Relaxed) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Collection {
    #[default]
    Music,
    Sfx,
}

impl Collection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Music => "music",
            Self::Sfx => "sfx",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Track {
    id: String,
    title: String,
}

#[derive(Deserialize)]
struct PublishedTrack {
    #[serde(flatten)]
    track: Track,
    collection: String,
    licence: Option<String>,
}

#[derive(Deserialize)]
struct Details {
    #[serde(flatten)]
    published: PublishedTrack,
    downloads: Vec<Download>,
}

#[derive(Deserialize)]
struct Download {
    format: String,
    bytes: Option<usize>,
}

fn preview_dir(root: &Path) -> PathBuf {
    root.join(PREVIEW_DIR)
}

fn preview_path(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err("Invalid Kaino track.".into());
    }
    Ok(preview_dir(root).join(format!("{id}.mp3")))
}

fn preview_usable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| {
        meta.is_file()
            && meta.len() >= PREVIEW_MIN_BYTES as u64
            && meta.len() <= PREVIEW_BYTES as u64
    })
}

fn looks_like_mp3(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)
}

async fn track_details(
    client: &reqwest::Client,
    progress: &Channel<MusicProgress>,
    id: &str,
    collection: Collection,
) -> Result<Details> {
    let url = format!("{BASE}/api/library/{}/{id}", collection.as_str());
    let details = retry_network(progress, |attempt| {
        let (client, url, progress) = (client, &url, progress);
        async move {
            report(progress, "checkingTrack", attempt, None);
            let response = client
                .get(url.as_str())
                .send()
                .await
                .map_err(network_error)?;
            read_json::<Details>(response).await
        }
    })
    .await?;
    if !eligible(&details.published, collection) || details.published.track.id != id {
        return Err("This track is no longer available from Kaino under CC0.".into());
    }
    Ok(details)
}

fn mp3_download(details: &Details) -> Result<&Download> {
    details
        .downloads
        .iter()
        .find(|file| file.format == "mp3")
        .ok_or_else(|| "Kaino does not offer an MP3 for this track.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    items: Vec<PublishedTrack>,
    next_page: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    tracks: Vec<Track>,
    next_page: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicProgress {
    stage: &'static str,
    attempt: u8,
    fraction: Option<f64>,
}

fn report(
    progress: &Channel<MusicProgress>,
    stage: &'static str,
    attempt: u8,
    fraction: Option<f64>,
) {
    let _ = progress.send(MusicProgress {
        stage,
        attempt,
        fraction,
    });
}

struct RequestError {
    message: String,
    retry: bool,
}

impl From<&str> for RequestError {
    fn from(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: false,
        }
    }
}

fn network_error(error: reqwest::Error) -> RequestError {
    let status = error.status();
    RequestError {
        retry: status.map_or_else(
            || error.is_connect() || error.is_timeout() || error.is_body() || error.is_request(),
            |status| matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504),
        ),
        message: if let Some(status) = status {
            format!("Kaino returned HTTP {}.", status.as_u16())
        } else if error.is_timeout() {
            "Kaino took too long to respond.".into()
        } else if error.is_body() {
            "The transfer from Kaino was interrupted.".into()
        } else {
            "Could not connect to Kaino.".into()
        },
    }
}

async fn retry_network<T, F>(
    progress: &Channel<MusicProgress>,
    mut work: impl FnMut(u8) -> F,
) -> Result<T>
where
    F: std::future::Future<Output = std::result::Result<T, RequestError>> + Send,
{
    for attempt in 1..=NETWORK_ATTEMPTS {
        match work(attempt).await {
            Ok(value) => return Ok(value),
            Err(error) if error.retry && attempt < NETWORK_ATTEMPTS => {
                report(progress, "retrying", attempt + 1, None);
                tokio::time::sleep(Duration::from_millis(600 * u64::from(attempt))).await;
            }
            Err(error) => return Err(error.message),
        }
    }
    unreachable!()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn eligible(track: &PublishedTrack, collection: Collection) -> bool {
    track.collection == collection.as_str()
        && track.licence.as_deref() == Some("CC0-1.0")
        && valid_id(&track.track.id)
        && !track.track.title.trim().is_empty()
}

fn root_for(app: &AppHandle, collection: Collection) -> Result<PathBuf> {
    let base = app
        .path()
        .app_local_data_dir()
        .map(|path| path.join("music").join("kaino"))
        .map_err(|error| error.to_string())?;
    Ok(match collection {
        Collection::Music => base,
        Collection::Sfx => base.join("sfx"),
    })
}

fn track_dir(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err("Invalid Kaino track.".into());
    }
    Ok(root.join(id))
}

fn cached_track(directory: &Path, id: &str) -> Option<Track> {
    let metadata = fs::metadata(directory.join("track.mp3")).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let track: Track =
        serde_json::from_slice(&fs::read(directory.join("track.json")).ok()?).ok()?;
    (track.id == id).then_some(track)
}

pub fn local_path(app: &AppHandle, collection: Collection, id: &str) -> Result<PathBuf> {
    let directory = track_dir(&root_for(app, collection)?, id)?;
    cached_track(&directory, id)
        .map(|_| directory.join("track.mp3"))
        .ok_or_else(|| "Download this track from the Kaino library before using it.".into())
}

fn client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(true)
        .user_agent(concat!("MiniVidCut/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(12))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() <= 2
                && url.scheme() == "https"
                && url.port_or_known_default() == Some(443)
                && matches!(url.host_str(), Some("kaino.dev" | DOWNLOAD_HOST))
            {
                attempt.follow()
            } else {
                attempt.error("Unexpected music download location")
            }
        }))
        .build()
        .map_err(|_| "Could not connect to Kaino.".into())
}

async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> std::result::Result<T, RequestError> {
    let mut response = response.error_for_status().map_err(network_error)?;
    let events = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| kind.starts_with("text/event-stream"));
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("Kaino returned too much data.".into());
        }
        bytes.extend_from_slice(&chunk);
        if events {
            if let Some(result) = parse_event_json(&bytes) {
                return Ok(result);
            }
        }
    }
    let parsed = if events {
        parse_event_json(&bytes)
    } else {
        serde_json::from_slice(&bytes).ok()
    };
    parsed.ok_or_else(|| "Could not read Kaino’s response.".into())
}

fn parse_event_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    let text = std::str::from_utf8(bytes).ok()?.replace("\r\n", "\n");
    text.split_inclusive("\n\n")
        .filter(|event| event.ends_with("\n\n"))
        .find_map(|event| {
            let data = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|value| value.strip_prefix(' ').unwrap_or(value))
                .collect::<Vec<_>>()
                .join("\n");
            serde_json::from_str(&data).ok()
        })
}

#[tauri::command]
pub async fn search_kaino(
    query: String,
    page: u32,
    collection: Option<Collection>,
    progress: Channel<MusicProgress>,
) -> Result<SearchPage> {
    let collection = collection.unwrap_or(Collection::Music);
    #[derive(Deserialize)]
    struct Response {
        result: ToolResult,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ToolResult {
        structured_content: SearchResult,
    }
    let query: String = query.trim().chars().take(100).collect();
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"search_library","arguments":{"collection":collection.as_str(),"q":query,"page":page.clamp(1,10000)}
    }});
    let client = client(Duration::from_secs(12))?;
    let body = body.to_string();
    let search = retry_network(&progress, |attempt| {
        let (client, body, progress) = (&client, &body, &progress);
        async move {
            report(progress, "loadingCatalog", attempt, None);
            let response = client
                .post(format!("{BASE}/mcp"))
                .header("Accept", "application/json, text/event-stream")
                .header("Content-Type", "application/json")
                .header("MCP-Protocol-Version", "2025-03-26")
                .body(body.clone())
                .send()
                .await
                .map_err(network_error)?;
            Ok(read_json::<Response>(response)
                .await?
                .result
                .structured_content)
        }
    })
    .await?;
    Ok(SearchPage {
        tracks: search
            .items
            .into_iter()
            .filter(|track| eligible(track, collection))
            .map(|item| item.track)
            .collect(),
        next_page: search.next_page,
    })
}

#[tauri::command]
pub async fn local_kaino_tracks(
    app: AppHandle,
    collection: Option<Collection>,
) -> Result<Vec<Track>> {
    let collection = collection.unwrap_or(Collection::Music);
    video::background(move || {
        let entries = match fs::read_dir(root_for(&app, collection)?) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut tracks = entries
            .flatten()
            .filter_map(|entry| {
                let id = entry.file_name().into_string().ok()?;
                valid_id(&id)
                    .then(|| cached_track(&entry.path(), &id))
                    .flatten()
            })
            .collect::<Vec<_>>();
        tracks.sort_by_cached_key(|track| track.title.to_lowercase());
        Ok(tracks)
    })
    .await
}

#[tauri::command]
pub async fn download_kaino(
    app: AppHandle,
    id: String,
    collection: Option<Collection>,
    progress: Channel<MusicProgress>,
    cancels: State<'_, DownloadCancels>,
) -> Result<Track> {
    let collection = collection.unwrap_or(Collection::Music);
    let root = root_for(&app, collection)?;
    let directory = track_dir(&root, &id)?;
    if let Some(track) = cached_track(&directory, &id) {
        return Ok(track);
    }
    let flag = cancels.begin(&id);
    let _guard = CancelGuard {
        cancels: &cancels,
        id: id.clone(),
    };
    check_cancel(&flag)?;
    let client = client(Duration::from_secs(90))?;
    let details = track_details(&client, &progress, &id, collection).await?;
    check_cancel(&flag)?;
    let listed_size = mp3_download(&details)?.bytes;
    let download_url = format!(
        "{BASE}/api/library/{}/{id}/download?format=mp3",
        collection.as_str()
    );
    let bytes = retry_network(&progress, |attempt| {
        let (client, download_url, progress) = (&client, &download_url, &progress);
        let flag = Arc::clone(&flag);
        async move {
            check_cancel(&flag).map_err(|message| RequestError {
                message,
                retry: false,
            })?;
            report(progress, "downloading", attempt, None);
            let mut response = client
                .get(download_url.as_str())
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(network_error)?;
            let expected = listed_size.or(response
                .content_length()
                .and_then(|size| usize::try_from(size).ok()));
            if expected.is_some_and(|size| size > MAX_AUDIO || size == 0) {
                return Err("Invalid track size.".into());
            }
            let mut bytes = Vec::with_capacity(expected.unwrap_or(0));
            let mut last_percent = None;
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                check_cancel(&flag).map_err(|message| RequestError {
                    message,
                    retry: false,
                })?;
                if bytes.len() + chunk.len() > expected.unwrap_or(MAX_AUDIO) {
                    return Err("Invalid track size.".into());
                }
                bytes.extend_from_slice(&chunk);
                if let Some(size) = expected {
                    let percent = (bytes.len() * 100 / size) as u8;
                    if last_percent != Some(percent) {
                        last_percent = Some(percent);
                        report(
                            progress,
                            "downloading",
                            attempt,
                            Some(f64::from(percent) / 100.0),
                        );
                    }
                }
            }
            if bytes.is_empty() || expected.is_some_and(|size| size != bytes.len()) {
                return Err(RequestError {
                    message: "The track download was incomplete.".into(),
                    retry: true,
                });
            }
            Ok(bytes)
        }
    })
    .await?;
    check_cancel(&flag)?;
    report(&progress, "saving", 1, None);
    let track = details.published.track;
    video::background(move || save_track(&root, &directory, track, &bytes)).await
}

fn save_track(root: &Path, directory: &Path, track: Track, bytes: &[u8]) -> Result<Track> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let stage = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
    let audio = stage.path().join("track.mp3");
    {
        let mut file = fs::File::create(&audio).map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    if !video::audio_stream(&audio, Some("mp3"))? {
        return Err("Kaino did not return readable MP3 audio.".into());
    }
    fs::write(
        stage.path().join("track.json"),
        serde_json::to_vec(&track).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    match fs::rename(stage.path(), directory) {
        Ok(()) => Ok(track),
        Err(error) => cached_track(directory, &track.id)
            .ok_or_else(|| format!("Could not save the track: {error}")),
    }
}

async fn fetch_preview(
    client: &reqwest::Client,
    progress: &Channel<MusicProgress>,
    id: &str,
    collection: Collection,
) -> Result<Vec<u8>> {
    let url = format!(
        "{BASE}/api/library/{}/{id}/download?format=mp3",
        collection.as_str()
    );
    retry_network(progress, |attempt| {
        let (client, url, progress) = (client, &url, progress);
        async move {
            report(progress, "previewing", attempt, None);
            let mut response = client
                .get(url.as_str())
                .header(
                    reqwest::header::RANGE,
                    format!("bytes=0-{}", PREVIEW_BYTES - 1),
                )
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(network_error)?;
            if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                let range = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                if !range.starts_with("bytes 0-") {
                    return Err("Kaino returned an unexpected preview range.".into());
                }
            }
            // Stop reading once we have enough for an audition, even if the
            // server ignored the range request and started sending the full file.
            let mut bytes = Vec::with_capacity(PREVIEW_BYTES);
            while bytes.len() < PREVIEW_BYTES {
                let Some(chunk) = response.chunk().await.map_err(network_error)? else {
                    break;
                };
                bytes.extend_from_slice(&chunk);
            }
            bytes.truncate(PREVIEW_BYTES);
            if bytes.len() < PREVIEW_MIN_BYTES || !looks_like_mp3(&bytes) {
                return Err(RequestError {
                    message: "Kaino did not return a readable preview.".into(),
                    retry: true,
                });
            }
            Ok(bytes)
        }
    })
    .await
}

/// Fetch a short, playable sample of a Kaino track without adding it to the
/// downloaded library. The partial MP3 is cached separately so repeated
/// auditions work offline and never count as an installed track.
#[tauri::command]
pub async fn preview_kaino(
    app: AppHandle,
    id: String,
    collection: Option<Collection>,
    progress: Channel<MusicProgress>,
) -> Result<PathBuf> {
    let collection = collection.unwrap_or(Collection::Music);
    let root = root_for(&app, collection)?;
    let path = preview_path(&root, &id)?;
    if preview_usable(&path) {
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| error.to_string())?;
        return Ok(path);
    }
    let client = client(Duration::from_secs(30))?;
    let details = track_details(&client, &progress, &id, collection).await?;
    mp3_download(&details)?;
    let bytes = fetch_preview(&client, &progress, &id, collection).await?;
    report(&progress, "saving", 1, None);
    let path = video::background(move || {
        let directory = preview_dir(&root);
        let path = preview_path(&root, &id)?;
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let stage = tempfile::tempdir_in(&directory).map_err(|error| error.to_string())?;
        let file = stage.path().join("preview.mp3");
        fs::write(&file, &bytes).map_err(|error| error.to_string())?;
        fs::rename(&file, &path).map_err(|error| error.to_string())?;
        Ok::<PathBuf, String>(path)
    })
    .await?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn remove_kaino(
    app: AppHandle,
    id: String,
    collection: Option<Collection>,
) -> Result<()> {
    let collection = collection.unwrap_or(Collection::Music);
    video::background(move || {
        let root = root_for(&app, collection)?;
        let directory = track_dir(&root, &id)?;
        if !directory.exists() {
            return Ok(());
        }
        let staging = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
        fs::rename(directory, staging.path().join("removed"))
            .map_err(|error| format!("Could not remove the track: {error}"))?;
        staging
            .close()
            .map_err(|error| format!("Could not delete the downloaded audio: {error}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_complete_streamed_catalog_results_and_ignores_keepalives() {
        let stream = b": keepalive\r\n\r\nevent: message\r\ndata: {\r\ndata: \"nextPage\": 2\r\ndata: }\r\n\r\n";
        assert_eq!(
            parse_event_json::<serde_json::Value>(stream).unwrap()["nextPage"],
            2
        );
        assert!(parse_event_json::<serde_json::Value>(b"data: {}\n").is_none());
    }

    #[test]
    fn temporary_errors_retry_and_permanent_errors_stop() {
        tauri::async_runtime::block_on(async {
            let progress = Channel::new(|_| Ok(()));
            let mut tries = 0;
            let value = retry_network(&progress, |attempt| {
                tries += 1;
                std::future::ready(if attempt == 1 {
                    Err(RequestError {
                        message: "Temporary".into(),
                        retry: true,
                    })
                } else {
                    Ok(42)
                })
            })
            .await
            .unwrap();
            assert_eq!((value, tries), (42, 2));
            let mut tries = 0;
            let failure = retry_network::<(), _>(&progress, |_| {
                tries += 1;
                std::future::ready(Err("Permanent".into()))
            })
            .await;
            assert_eq!(failure.unwrap_err(), "Permanent");
            assert_eq!(tries, 1);
        });
    }

    #[test]
    fn accepts_only_licensed_music_and_safe_provider_ids() {
        let track = |id: &str, licence: &str, collection: &str| PublishedTrack {
            track: Track {
                id: id.to_owned(),
                title: "Cosmic Haven".into(),
            },
            collection: collection.into(),
            licence: Some(licence.into()),
        };
        assert!(eligible(
            &track("afrobeat-01", "CC0-1.0", "music"),
            Collection::Music
        ));
        assert!(!eligible(
            &track("afrobeat-01", "CC-BY-4.0", "music"),
            Collection::Music
        ));
        assert!(!eligible(
            &track("afrobeat-01", "CC0-1.0", "sfx"),
            Collection::Music
        ));
        assert!(eligible(
            &track("amb-beach-01", "CC0-1.0", "sfx"),
            Collection::Sfx
        ));
        assert!(!eligible(
            &track("amb-beach-01", "CC0-1.0", "sfx"),
            Collection::Music
        ));
        assert_eq!(Collection::default(), Collection::Music);
        for id in ["../track", "con.mp3", "a--b", "a/b", "a%2fb"] {
            assert!(track_dir(Path::new("music"), id).is_err());
        }
    }

    #[test]
    fn cancellation_is_scoped_to_one_download_and_cleared_when_it_finishes() {
        let cancels = DownloadCancels::default();
        let first = cancels.begin("track-a");
        let second = cancels.begin("track-b");
        assert!(check_cancel(&first).is_ok());
        assert!(check_cancel(&second).is_ok());
        cancels.cancel("track-a");
        assert_eq!(check_cancel(&first).unwrap_err(), CANCELLED);
        assert!(check_cancel(&second).is_ok());
        cancels.finish("track-a");
        let fresh = cancels.begin("track-a");
        assert!(check_cancel(&fresh).is_ok());
    }

    #[test]
    fn previews_use_a_separate_cache_and_are_never_mistaken_for_downloaded_tracks() {
        let root = Path::new("music");
        assert!(!valid_id(PREVIEW_DIR));
        assert_eq!(
            preview_path(root, "afrobeat-01").unwrap(),
            preview_dir(root).join("afrobeat-01.mp3")
        );
        for id in ["../track", "a--b", "A-ok"] {
            assert!(preview_path(root, id).is_err());
        }
    }

    #[test]
    fn only_short_readable_samples_are_reused_as_previews() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("afrobeat-01.mp3");
        assert!(!preview_usable(&path));
        fs::write(&path, vec![0; PREVIEW_MIN_BYTES - 1]).unwrap();
        assert!(!preview_usable(&path));
        fs::write(&path, vec![0; PREVIEW_MIN_BYTES]).unwrap();
        assert!(preview_usable(&path));
        fs::write(&path, vec![0; PREVIEW_BYTES + 1]).unwrap();
        assert!(!preview_usable(&path));
    }

    #[test]
    fn previews_reject_non_audio_responses() {
        assert!(looks_like_mp3(b"ID3\x04\0\0\0\0\0\0"));
        assert!(looks_like_mp3(&[0xFF, 0xFB, 0x90, 0x64]));
        assert!(!looks_like_mp3(b"<!doctype html>"));
        assert!(!looks_like_mp3(b""));
    }

    #[test]
    #[ignore = "requires network access to kaino.dev"]
    fn fetches_a_playable_preview_from_kaino() {
        tauri::async_runtime::block_on(async {
            let progress = Channel::new(|_| Ok(()));
            let client = client(Duration::from_secs(30)).unwrap();
            let bytes = fetch_preview(&client, &progress, "acoustic-folk-01", Collection::Music)
                .await
                .unwrap();
            assert!(bytes.len() >= PREVIEW_MIN_BYTES);
            assert!(bytes.len() <= PREVIEW_BYTES);
            assert!(looks_like_mp3(&bytes));
        });
    }

    #[test]
    fn incomplete_downloads_are_hidden_and_invalid_audio_is_never_published() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("afrobeat-01");
        assert!(save_track(
            root.path(),
            &directory,
            Track {
                id: "afrobeat-01".into(),
                title: "Test".into()
            },
            b"invalid"
        )
        .is_err());
        assert!(!directory.exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("track.mp3"), b"partial").unwrap();
        assert!(cached_track(&directory, "afrobeat-01").is_none());
    }
}
