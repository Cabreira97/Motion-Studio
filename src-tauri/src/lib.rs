//! Motion Studio — Tauri entry point.
//!
//! Architecture: the React webview owns the pure render planner; this Rust side
//! owns the OS integration a webview cannot do safely — SQLite persistence,
//! running the locally-installed ffmpeg, cursor sampling, the system tray and
//! the recording timer.
//!
//! Capture is split by platform. On Windows and macOS the webview records it
//! with `getDisplayMedia` + `MediaRecorder`. On Linux/BSD it cannot: WebKitGTK
//! hands out display frames that encode to nothing and read back black, so
//! capture is native there — see src/native_capture.rs.

mod capture;
mod commands;
mod filename;
mod media;
#[cfg(all(unix, not(target_os = "macos")))]
mod native_capture;
mod session;
mod store;
#[cfg(all(unix, not(target_os = "macos")))]
mod webview_linux;

use std::sync::Mutex;

use capture::CursorSampler;
use commands::AppState;
use session::Session;
use store::Store;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load local configuration (FFMPEG_PATH, WHISPER_CPP_BIN, ...) from .env.
    for candidate in [".env", "../.env"] {
        let _ = dotenvy::from_filename(candidate);
    }

    // Before the webview exists: WebKitGTK reads this when it builds its video
    // playback pipeline, and without it the editor preview plays a recording
    // and shows black. No-op elsewhere.
    #[cfg(all(unix, not(target_os = "macos")))]
    webview_linux::prefer_software_video_sink();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let recordings_dir = data_dir.join("recordings");
            std::fs::create_dir_all(&recordings_dir)?;

            let store = Store::open(&data_dir.join("motion-studio.sqlite"))
                .map_err(std::io::Error::other)?;

            app.manage(AppState {
                store: Mutex::new(store),
                session: Session::new(),
                cursor: CursorSampler::new(),
                recordings_dir,
                #[cfg(all(unix, not(target_os = "macos")))]
                native_capture: Mutex::new(None),
            });

            session::build_tray(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::capture_capabilities,
            commands::native_capture_start,
            commands::native_capture_stop,
            commands::run_ffmpeg,
            commands::probe_media,
            commands::resolve_recording_path,
            commands::save_recording,
            commands::write_text_file,
            commands::write_binary_file,
            commands::file_exists,
            commands::file_size,
            commands::ensure_dir,
            commands::reveal_path,
            commands::copy_path,
            commands::find_system_font,
            commands::session_start,
            commands::session_stop,
            commands::session_state,
            commands::emit_tick,
            commands::cursor_start,
            commands::cursor_stop,
            commands::list_projects,
            commands::get_project,
            commands::save_project,
            commands::delete_project,
            commands::transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
