use serde::{Deserialize, Serialize};
use std::{fs, io::ErrorKind, path::Path};
use tauri::{ipc::Channel, AppHandle};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelId {
    Speech,
    Language,
}

#[derive(Serialize)]
pub struct ModelStatus {
    id: ModelId,
    bytes: u64,
    installed: bool,
}

#[tauri::command]
pub fn local_models(app: AppHandle) -> Result<[ModelStatus; 2], String> {
    Ok([
        ModelStatus {
            id: ModelId::Speech,
            bytes: crate::captions::MODEL_BYTES,
            installed: crate::captions::installed(&crate::captions::model_path(&app)?),
        },
        ModelStatus {
            id: ModelId::Language,
            bytes: crate::titles::MODEL_BYTES,
            installed: crate::titles::model_installed(&app)?,
        },
    ])
}

#[tauri::command]
pub async fn manage_local_model(
    app: AppHandle,
    id: ModelId,
    install: bool,
    progress: Channel<String>,
) -> Result<(), String> {
    match id {
        ModelId::Speech => crate::captions::manage_model(app, install, progress).await,
        ModelId::Language => crate::titles::manage_model(app, install, progress).await,
    }
}

/// Stops a model download started from Settings. Removing a model is quick
/// and is never canceled.
#[tauri::command]
pub fn cancel_model_download(app: AppHandle, id: ModelId) -> Result<(), String> {
    match id {
        ModelId::Speech => crate::captions::cancel_captions(app),
        ModelId::Language => {
            crate::titles::cancel_download();
            Ok(())
        }
    }
}

pub(crate) fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("MiniVidCut couldn’t remove the model. Try again.".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn removing_model_is_repeatable_and_keeps_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let model = directory.path().join("model.gguf");
        let other = directory.path().join("other.gguf");
        std::fs::write(&model, b"model").unwrap();
        std::fs::write(&other, b"other").unwrap();
        super::remove_file(&model).unwrap();
        super::remove_file(&model).unwrap();
        assert!(!model.exists());
        assert!(other.is_file());
    }
}
