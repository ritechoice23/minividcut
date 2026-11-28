mod agents;
mod bookends;
mod caption_overlay;
mod caption_render;
mod captions;
mod export_batch;
mod kaino;
mod models;
mod music_library;
mod titles;
mod transcripts;
mod video;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(video::PreviewFiles::default())
        .manage(video::Exports::default())
        .manage(captions::CaptionEngine::default())
        .manage(titles::TitleEngine::default())
        .manage(agents::AgentEngine::default())
        .manage(caption_overlay::CaptionOverlays::default())
        .manage(kaino::DownloadCancels::default())
        .invoke_handler(tauri::generate_handler![
            captions::caption_model,
            captions::generate_captions,
            captions::cancel_captions,
            transcripts::transcript_cache_bytes,
            transcripts::clear_transcript_cache,
            titles::generate_title,
            titles::select_moment,
            agents::detect_agents,
            agents::agent_signin_state,
            agents::agent_login,
            agents::test_agent,
            agents::run_agent_search,
            agents::cancel_agent_job,
            agents::open_agent_link,
            agents::opencode_models,
            models::local_models,
            models::manage_local_model,
            models::cancel_model_download,
            caption_overlay::prepare_caption_overlay,
            caption_overlay::discard_caption_overlays,
            video::open_video,
            video::audio_peaks,
            video::allow_asset,
            video::release_asset,
            video::open_music,
            video::import_music,
            video::local_imported_tracks,
            video::remove_imported_music,
            bookends::inspect_bookend,
            bookends::bookend_thumbnail,
            kaino::search_kaino,
            kaino::local_kaino_tracks,
            kaino::preview_kaino,
            kaino::download_kaino,
            kaino::cancel_kaino,
            kaino::remove_kaino,
            video::thumbnails,
            video::clip_thumbnails,
            video::prepare_preview,
            video::warm_encoders,
            video::export_clips,
            video::cancel_export,
            video::open_export_folder
        ])
        .run(tauri::generate_context!())
        .expect("could not start MiniVidCut");
}
