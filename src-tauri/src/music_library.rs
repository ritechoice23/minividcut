use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;

struct Track {
    id: &'static str,
    bytes: usize,
    sha256: &'static str,
}

const TRACKS: &[Track] = &[
    Track {
        id: "a-brand-new-wisdom",
        bytes: 265389,
        sha256: "99d0095c328d598f5fb1bca9fbb4a518112bbf676dc662f0c0c6edfee88d788c",
    },
    Track {
        id: "just-saying-tho",
        bytes: 397509,
        sha256: "687aa35987b89797af14735348c5b2f1b766ac0ba528dc001746aaf4ca1cc82f",
    },
    Track {
        id: "winter-dust",
        bytes: 468597,
        sha256: "8c0da93d35ddfb3c8e4cc01ce4ba6611fb407eec4b6c23f17a691ad7dc0f1fe0",
    },
    Track {
        id: "swinging-sweet",
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
        return Err("The original music file is missing. Choose another track.".into());
    }
    Ok(path)
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
