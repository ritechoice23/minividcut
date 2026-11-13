mod video;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(video::PreviewFiles::default())
        .manage(video::ExportFolder::default())
        .invoke_handler(tauri::generate_handler![
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
