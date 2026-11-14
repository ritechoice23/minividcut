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

#[derive(Deserialize, Serialize)]
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

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(90))
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

async fn read_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let mut response = response
        .error_for_status()
        .map_err(|_| "Kaino could not complete the request.")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Kaino interrupted the request. Try again.")?
    {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("Kaino returned too much data.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Could not read Kaino’s response.".into())
}

#[tauri::command]
pub async fn search_kaino(query: String, page: u32) -> Result<SearchPage> {
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
    let response = client()?
        .post(format!("{BASE}/mcp"))
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| "Could not reach Kaino. Check your connection and try again.")?;
    let search = read_json::<Response>(response)
        .await?
        .result
        .structured_content;
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
pub async fn download_kaino(app: AppHandle, id: String, progress: Channel<f64>) -> Result<Track> {
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
    let client = client()?;
    let url = format!("{BASE}/api/library/music/{id}");
    let details = read_json::<Details>(
        client
            .get(&url)
            .send()
            .await
            .map_err(|_| "Could not read track details from Kaino.")?,
    )
    .await?;
    if !eligible(&details.published) || details.published.track.id != id {
        return Err("This track is no longer available from Kaino under CC0.".into());
    }
    let expected = details
        .downloads
        .iter()
        .find(|file| file.format == "mp3")
        .ok_or("Kaino does not offer an MP3 for this track.")?
        .bytes;
    let mut response = client
        .get(format!("{url}/download?format=mp3"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "Could not download the Kaino track. Try again.")?;
    let expected = expected.or(response
        .content_length()
        .and_then(|size| usize::try_from(size).ok()));
    if expected.is_some_and(|size| size > MAX_AUDIO || size == 0) {
        return Err("Invalid track size.".into());
    }
    let mut bytes = Vec::with_capacity(expected.unwrap_or(0));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The track download was interrupted. Try again.")?
    {
        if bytes.len() + chunk.len() > expected.unwrap_or(MAX_AUDIO) {
            return Err("Invalid track size.".into());
        }
        bytes.extend_from_slice(&chunk);
        if let Some(size) = expected {
            let _ = progress.send(bytes.len() as f64 / size as f64);
        }
    }
    if bytes.is_empty() || expected.is_some_and(|size| size != bytes.len()) {
        return Err("The track download was incomplete. Try again.".into());
    }
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
