mod caption_overlay;
mod caption_render;
mod captions;
mod export_batch;
mod video;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(video::PreviewFiles::default())
        .manage(video::Exports::default())
        .manage(captions::CaptionEngine::default())
        .manage(caption_overlay::CaptionOverlays::default())
        .invoke_handler(tauri::generate_handler![
            captions::caption_model,
            captions::generate_captions,
            captions::cancel_captions,
            caption_overlay::prepare_caption_overlay,
            caption_overlay::discard_caption_overlays,
            video::open_video,
            video::thumbnails,
            video::clip_thumbnail,
            video::prepare_preview,
            video::export_clips,
            video::open_export_folder
        ])
        .run(tauri::generate_context!())
        .expect("could not start MiniVidCut");
}
