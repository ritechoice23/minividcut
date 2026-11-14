use crate::video::{self, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager};

const BASE: &str = "https://kaino.dev";
const DOWNLOAD_HOST: &str = "a3abcd2451736f6a3867db58e7c8ec05.r2.cloudflarestorage.com";
const MAX_AUDIO: usize = 32 * 1024 * 1024;
const NETWORK_ATTEMPTS: u8 = 3;

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

fn eligible(track: &PublishedTrack) -> bool {
    track.collection == "music"
        && track.licence.as_deref() == Some("CC0-1.0")
        && valid_id(&track.track.id)
        && !track.track.title.trim().is_empty()
}

fn root(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("music").join("kaino"))
        .map_err(|error| error.to_string())
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

pub fn local_path(app: &AppHandle, id: &str) -> Result<PathBuf> {
    let directory = track_dir(&root(app)?, id)?;
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
    progress: Channel<MusicProgress>,
) -> Result<SearchPage> {
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
        "name":"search_library","arguments":{"collection":"music","q":query,"page":page.clamp(1,10000)}
    }});
    let client = client(Duration::from_secs(12))?;
    let body = body.to_string();
    let search = retry_network(&progress, |attempt| {
        let (client, body, progress) = (&client, &body, &progress);
        async move {
            report(&progress, "loadingCatalog", attempt, None);
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
            .filter(eligible)
            .map(|item| item.track)
            .collect(),
        next_page: search.next_page,
    })
}

#[tauri::command]
pub async fn local_kaino_tracks(app: AppHandle) -> Result<Vec<Track>> {
    video::background(move || {
        let entries = match fs::read_dir(root(&app)?) {
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
    progress: Channel<MusicProgress>,
) -> Result<Track> {
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

    let root = root(&app)?;
    let directory = track_dir(&root, &id)?;
    if let Some(track) = cached_track(&directory, &id) {
        return Ok(track);
    }
    let client = client(Duration::from_secs(90))?;
    let url = format!("{BASE}/api/library/music/{id}");
    let details = retry_network(&progress, |attempt| {
        let (client, url, progress) = (&client, &url, &progress);
        async move {
            report(&progress, "checkingTrack", attempt, None);
            let response = client
                .get(url.as_str())
                .send()
                .await
                .map_err(network_error)?;
            read_json::<Details>(response).await
        }
    })
    .await?;
    if !eligible(&details.published) || details.published.track.id != id {
        return Err("This track is no longer available from Kaino under CC0.".into());
    }
    let listed_size = details
        .downloads
        .iter()
        .find(|file| file.format == "mp3")
        .ok_or("Kaino does not offer an MP3 for this track.")?
        .bytes;
    let download_url = format!("{url}/download?format=mp3");
    let bytes = retry_network(&progress, |attempt| {
        let (client, download_url, progress) = (&client, &download_url, &progress);
        async move {
            report(&progress, "downloading", attempt, None);
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
                if bytes.len() + chunk.len() > expected.unwrap_or(MAX_AUDIO) {
                    return Err("Invalid track size.".into());
                }
                bytes.extend_from_slice(&chunk);
                if let Some(size) = expected {
                    let percent = (bytes.len() * 100 / size) as u8;
                    if last_percent != Some(percent) {
                        last_percent = Some(percent);
                        report(
                            &progress,
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

#[tauri::command]
pub async fn remove_kaino(app: AppHandle, id: String) -> Result<()> {
    video::background(move || {
        let root = root(&app)?;
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
        assert!(eligible(&track("afrobeat-01", "CC0-1.0", "music")));
        assert!(!eligible(&track("afrobeat-01", "CC-BY-4.0", "music")));
        assert!(!eligible(&track("afrobeat-01", "CC0-1.0", "sfx")));
        for id in ["../track", "con.mp3", "a--b", "a/b", "a%2fb"] {
            assert!(track_dir(Path::new("music"), id).is_err());
        }
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
