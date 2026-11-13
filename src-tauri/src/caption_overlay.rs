use crate::video::background;
use serde::Deserialize;
use std::{collections::HashMap, fmt::Write, fs, sync::Mutex};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State,
};

type Result<T> = std::result::Result<T, String>;
const MAX_PAYLOAD: usize = 128 * 1024 * 1024;
const MAX_FRAMES: usize = 36_000;

#[derive(Default)]
pub struct CaptionOverlays(Mutex<HashMap<String, Overlay>>);

pub struct Overlay {
    pub directory: tempfile::TempDir,
    pub x: u32,
    pub y: u32,
    width: u32,
    height: u32,
}

impl Overlay {
    pub fn fits(&self, width: u32, height: u32) -> bool {
        self.x + self.width <= width && self.y + self.height <= height
    }
}

impl CaptionOverlays {
    pub fn take(&self, id: &str) -> Result<Overlay> {
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .remove(id)
            .ok_or_else(|| "The caption artwork is missing. Export the clips again.".into())
    }
}

#[derive(Deserialize)]
struct Header {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    frames: Vec<Frame>,
    sizes: Vec<usize>,
}

#[derive(Deserialize)]
struct Frame {
    at: u64,
    image: usize,
}

pub(crate) fn prepare(payload: &[u8]) -> Result<Overlay> {
    let bad = || "The caption artwork could not be read.".to_owned();
    let length = u32::from_le_bytes(payload.get(..4).ok_or_else(bad)?.try_into().unwrap()) as usize;
    if length > 3_000_000 || payload.len() > MAX_PAYLOAD {
        return Err(bad());
    }
    let header: Header =
        serde_json::from_slice(payload.get(4..4 + length).ok_or_else(bad)?).map_err(|_| bad())?;
    if header.width == 0
        || header.height == 0
        || [header.x, header.y, header.width, header.height]
            .iter()
            .any(|value| *value > 1920)
        || header.frames.len() < 2
        || header.frames.len() > MAX_FRAMES
        || header.sizes.is_empty()
        || header.sizes.len() > MAX_FRAMES
        || header.frames[0].at != 0
        || header.frames.last().is_some_and(|frame| frame.image != 0)
        || header
            .frames
            .windows(2)
            .any(|pair| pair[0].at >= pair[1].at)
        || header
            .frames
            .iter()
            .any(|frame| frame.image >= header.sizes.len())
    {
        return Err(bad());
    }
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut images = &payload[4 + length..];
    for (index, size) in header.sizes.into_iter().enumerate() {
        let (image, rest) = images.split_at_checked(size).ok_or_else(bad)?;
        images = rest;
        if image.len() < 33
            || !image.starts_with(b"\x89PNG\r\n\x1a\n")
            || &image[12..16] != b"IHDR"
            || image[16..20] != header.width.to_be_bytes()
            || image[20..24] != header.height.to_be_bytes()
        {
            return Err(bad());
        }
        fs::write(directory.path().join(format!("{index}.png")), image)
            .map_err(|error| error.to_string())?;
    }
    if !images.is_empty() {
        return Err(bad());
    }
    let mut list = String::from("ffconcat version 1.0\n");
    for (index, frame) in header.frames.iter().enumerate() {
        let _ = writeln!(list, "file {}.png\noption framerate 1000", frame.image);
        if let Some(next) = header.frames.get(index + 1) {
            let ms = next.at - frame.at;
            let _ = writeln!(list, "duration {}.{:03}", ms / 1000, ms % 1000);
        }
    }
    fs::write(directory.path().join("captions.ffconcat"), list)
        .map_err(|error| error.to_string())?;
    Ok(Overlay {
        directory,
        x: header.x,
        y: header.y,
        width: header.width,
        height: header.height,
    })
}

#[tauri::command]
pub async fn prepare_caption_overlay(app: AppHandle, request: Request<'_>) -> Result<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected caption artwork.".into());
    };
    if bytes.len() > MAX_PAYLOAD {
        return Err("This caption artwork is too large. Try a shorter clip.".into());
    }
    let payload = bytes.clone();
    background(move || {
        let overlay = prepare(&payload)?;
        let id = overlay
            .directory
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let store = app.state::<CaptionOverlays>();
        let mut overlays = store.0.lock().map_err(|error| error.to_string())?;
        if overlays.len() >= 100 {
            return Err("Too many caption overlays are ready for export.".into());
        }
        overlays.insert(id.clone(), overlay);
        Ok(id)
    })
    .await
}

#[tauri::command]
pub fn discard_caption_overlays(store: State<'_, CaptionOverlays>, ids: Vec<String>) {
    if let Ok(mut overlays) = store.0.lock() {
        for id in ids {
            overlays.remove(&id);
        }
    }
}
