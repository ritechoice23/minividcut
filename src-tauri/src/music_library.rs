use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf, time::Duration};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn browse_mixkit(app: AppHandle) -> Result<()> {
    app.opener()
        .open_url("https://mixkit.co/free-stock-music/", None::<&str>)
        .map_err(|error| error.to_string())
}

type Result<T> = std::result::Result<T, String>;

struct Track {
    id: &'static str,
    filename: &'static str,
    bytes: usize,
    sha256: &'static str,
}

const TRACKS: &[Track] = &[
    Track {
        id: "a-brand-new-wisdom",
        filename: "A%20Brand%20New%20Wisdom.ogg",
        bytes: 265389,
        sha256: "99d0095c328d598f5fb1bca9fbb4a518112bbf676dc662f0c0c6edfee88d788c",
    },
    Track {
        id: "just-saying-tho",
        filename: "Just%20Saying%20Tho.ogg",
        bytes: 397509,
        sha256: "687aa35987b89797af14735348c5b2f1b766ac0ba528dc001746aaf4ca1cc82f",
    },
    Track {
        id: "winter-dust",
        filename: "Winter%20Dust_0.ogg",
        bytes: 468597,
        sha256: "8c0da93d35ddfb3c8e4cc01ce4ba6611fb407eec4b6c23f17a691ad7dc0f1fe0",
    },
    Track {
        id: "swinging-sweet",
        filename: "Swinging%20Sweet_0.ogg",
        bytes: 405170,
        sha256: "5a22466a7ec28c324324217aff836809ccbc9e2489cc22ebf72725f4bfd320bb",
    },
];

impl Track {
    fn path(&self, directory: &std::path::Path) -> PathBuf {
        directory.join(format!("{}.ogg", self.id))
    }

    fn verified(&self, bytes: &[u8]) -> bool {
        bytes.len() == self.bytes && format!("{:x}", Sha256::digest(bytes)) == self.sha256
    }

    fn installed(&self, path: &std::path::Path) -> bool {
        fs::metadata(path).is_ok_and(|meta| meta.len() == self.bytes as u64)
            && fs::read(path).is_ok_and(|bytes| self.verified(&bytes))
    }
}

fn track(id: &str) -> Result<&'static Track> {
    TRACKS
        .iter()
        .find(|track| track.id == id)
        .ok_or_else(|| "This track is no longer in the music library.".into())
}

fn directory(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("music"))
        .map_err(|error| error.to_string())
}

pub fn downloaded_path(app: &AppHandle, id: &str) -> Result<PathBuf> {
    let track = track(id)?;
    let path = track.path(&directory(app)?);
    if !track.installed(&path) {
        return Err("Download this track from the Music library before using it.".into());
    }
    Ok(path)
}

#[derive(Serialize)]
pub struct TrackStatus {
    id: &'static str,
    bytes: usize,
    installed: bool,
}

#[tauri::command]
pub async fn music_library(app: AppHandle) -> Result<Vec<TrackStatus>> {
    crate::video::background(move || {
        let directory = directory(&app)?;
        Ok(TRACKS
            .iter()
            .map(|track| TrackStatus {
                id: track.id,
                bytes: track.bytes,
                installed: track.installed(&track.path(&directory)),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn download_music(app: AppHandle, id: String, progress: Channel<f64>) -> Result<()> {
    let track = track(&id)?;
    let directory = directory(&app)?;
    let path = track.path(&directory);
    if track.installed(&path) {
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "Could not start the music download.")?;
    let mut response = client
        .get(format!(
            "https://opengameart.org/sites/default/files/{}",
            track.filename
        ))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "Could not download the track. Check your connection and try again.")?;
    let mut bytes = Vec::with_capacity(track.bytes);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The music download was interrupted. Try again.")?
    {
        if bytes.len() + chunk.len() > track.bytes {
            return Err("The track download could not be verified.".into());
        }
        bytes.extend_from_slice(&chunk);
        let _ = progress.send(bytes.len() as f64 / track.bytes as f64);
    }
    if !track.verified(&bytes) {
        return Err("The track download could not be verified.".into());
    }
    crate::video::background(move || {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(&path)
            .map_err(|error| format!("Could not save the track: {error}"))?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_or_modified_file_does_not_count_as_downloaded() {
        let directory = tempfile::tempdir().unwrap();
        let track = TRACKS.first().unwrap();
        let path = track.path(directory.path());
        assert!(!track.installed(&path));
        fs::write(&path, b"OggS").unwrap();
        assert!(!track.installed(&path));
        fs::write(&path, vec![0; track.bytes]).unwrap();
        assert!(!track.installed(&path));
        assert!(super::track("../anything").is_err());
    }
}
