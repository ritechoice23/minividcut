mod bookends;
mod caption_overlay;
mod caption_render;
mod captions;
mod export_batch;
mod kaino;
mod models;
mod music_library;
mod titles;
mod video;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(video::PreviewFiles::default())
        .manage(video::Exports::default())
        .manage(captions::CaptionEngine::default())
        .manage(titles::TitleEngine::default())
        .manage(caption_overlay::CaptionOverlays::default())
        .invoke_handler(tauri::generate_handler![
            captions::caption_model,
            captions::generate_captions,
            captions::cancel_captions,
            titles::generate_title,
            titles::select_moment,
            models::local_models,
            models::manage_local_model,
            caption_overlay::prepare_caption_overlay,
            caption_overlay::discard_caption_overlays,
            video::open_video,
            video::open_music,
            bookends::inspect_bookend,
            music_library::music_library,
            music_library::download_music,
            music_library::browse_mixkit,
            kaino::search_kaino,
            kaino::local_kaino_tracks,
            kaino::download_kaino,
            kaino::remove_kaino,
            video::thumbnails,
            video::clip_thumbnail,
            video::prepare_preview,
            video::export_clips,
            video::cancel_export,
            video::open_export_folder
        ])
        .run(tauri::generate_context!())
        .expect("could not start MiniVidCut");
}
