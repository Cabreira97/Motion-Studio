//! All Tauri commands exposed to the webview. Everything is local: file I/O,
//! SQLite, ffmpeg execution, cursor sampling and transcription.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::capture::{self, CaptureCapabilities, CursorSample};
use crate::filename;
use crate::media::{self, MediaInfo, ProcessOutput};
use crate::session::{Session, TickPayload};
use crate::store::{ProjectRow, Store};

pub struct AppState {
    pub store: Mutex<Store>,
    pub session: Session,
    pub cursor: capture::CursorSampler,
    pub recordings_dir: std::path::PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_data_dir: String,
    pub recordings_dir: String,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub cursor_sampling: bool,
    pub whisper_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub running: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub available: bool,
    pub reason: Option<String>,
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
    pub text: String,
}

impl TranscriptResult {
    fn unavailable(reason: impl Into<String>) -> Self {
        TranscriptResult {
            available: false,
            reason: Some(reason.into()),
            language: None,
            segments: Vec::new(),
            text: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_info(state: State<'_, AppState>) -> AppInfo {
    let data_dir = state.recordings_dir.clone();
    AppInfo {
        app_data_dir: data_dir
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        recordings_dir: data_dir.to_string_lossy().to_string(),
        ffmpeg_path: media::ffmpeg_path()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        ffprobe_path: media::ffprobe_path()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        cursor_sampling: state.cursor.is_supported(),
        whisper_available: whisper_configured(),
    }
}

#[tauri::command]
pub fn capture_capabilities() -> CaptureCapabilities {
    capture::capabilities()
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn run_ffmpeg(app: AppHandle, args: Vec<String>) -> Result<ProcessOutput, String> {
    media::validate_args(&args)?;

    let tool = &args[0];
    let stem = std::path::Path::new(tool)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(tool)
        .to_ascii_lowercase();
    let binary = if stem == "ffprobe" {
        media::ffprobe_path()?
    } else {
        media::ffmpeg_path()?
    };

    let mut full = args[1..].to_vec();
    // Ask ffmpeg for machine-readable progress on stdout (inserted before the
    // output path, which the planner always places last).
    if stem == "ffmpeg" && !full.is_empty() {
        let output = full
            .pop()
            .ok_or_else(|| "missing output path".to_string())?;
        full.push("-nostats".into());
        full.push("-progress".into());
        full.push("pipe:1".into());
        full.push(output);
    }

    let mut cmd = Command::new(&binary);
    cmd.args(&full)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", binary.display()))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let progress_handle = {
        let app = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut collected = String::new();
            for line in reader.lines().map_while(Result::ok) {
                if let Some(value) = line.strip_prefix("out_time_us=") {
                    if let Ok(micros) = value.trim().parse::<u64>() {
                        let _ = app.emit("export://progress", micros / 1000);
                    }
                }
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        })
    };

    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut collected = String::new();
        for line in reader.lines().map_while(Result::ok) {
            collected.push_str(&line);
            collected.push('\n');
        }
        collected
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = progress_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    Ok(ProcessOutput {
        code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

#[tauri::command]
pub fn probe_media(path: String) -> Result<MediaInfo, String> {
    media::probe(&path)
}

// ---------------------------------------------------------------------------
// Filesystem (all names are sanitized before touching disk)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn resolve_recording_path(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let safe = filename::sanitize(&name, "recording", 80);
    let path = state.recordings_dir.join(format!("{safe}.webm"));
    std::fs::create_dir_all(&state.recordings_dir).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_recording(
    state: State<'_, AppState>,
    name: String,
    data: Vec<u8>,
) -> Result<SavedFile, String> {
    let safe = filename::sanitize(&name, "recording", 80);
    std::fs::create_dir_all(&state.recordings_dir).map_err(|e| e.to_string())?;
    let mut path = state.recordings_dir.join(format!("{safe}.webm"));
    let mut index = 2;
    while path.exists() {
        path = state.recordings_dir.join(format!("{safe}-{index}.webm"));
        index += 1;
    }
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(SavedFile {
        path: path.to_string_lossy().to_string(),
        bytes: data.len() as u64,
    })
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_binary_file(path: String, data: Vec<u8>) -> Result<SavedFile, String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(SavedFile {
        path,
        bytes: data.len() as u64,
    })
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    capture::reveal_in_folder(&path)
}

#[tauri::command]
pub fn copy_path(app: AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// Best-effort lookup of a system font usable by ffmpeg `drawtext` for callouts.
#[tauri::command]
pub fn find_system_font() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &[
            "C:\\Windows\\Fonts\\segoeui.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
            "C:\\Windows\\Fonts\\calibri.ttf",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
        ]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ]
    };
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| (*p).to_string())
}

// ---------------------------------------------------------------------------
// Recording session + cursor sampling
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn session_start(app: AppHandle, state: State<'_, AppState>) -> SessionState {
    state.session.start(app);
    SessionState {
        running: true,
        elapsed_ms: 0,
    }
}

#[tauri::command]
pub fn session_stop(state: State<'_, AppState>) -> SessionState {
    let elapsed = state.session.elapsed_ms();
    state.session.stop();
    SessionState {
        running: false,
        elapsed_ms: elapsed,
    }
}

#[tauri::command]
pub fn session_state(state: State<'_, AppState>) -> SessionState {
    SessionState {
        running: state.session.is_running(),
        elapsed_ms: state.session.elapsed_ms(),
    }
}

#[tauri::command]
pub fn cursor_start(state: State<'_, AppState>, interval_ms: Option<u64>) {
    state.cursor.start(interval_ms.unwrap_or(40));
}

#[tauri::command]
pub fn cursor_stop(state: State<'_, AppState>) -> Vec<CursorSample> {
    state.cursor.stop()
}

/// Emits a tick immediately (used to sync the UI timer on mount).
#[tauri::command]
pub fn emit_tick(app: AppHandle, state: State<'_, AppState>) {
    let _ = app.emit(
        "recording://tick",
        TickPayload {
            elapsed_ms: state.session.elapsed_ms(),
        },
    );
}

// ---------------------------------------------------------------------------
// Project persistence
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectRow>, String> {
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .list_projects()
}

#[tauri::command]
pub fn get_project(state: State<'_, AppState>, id: String) -> Result<Option<ProjectRow>, String> {
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .get_project(&id)
}

#[tauri::command]
pub fn save_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    data: String,
) -> Result<(), String> {
    // Validate the payload is JSON before persisting.
    serde_json::from_str::<serde_json::Value>(&data)
        .map_err(|e| format!("invalid project json: {e}"))?;
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .upsert_project(&id, &name, created_at, updated_at, &data)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .delete_project(&id)
}

// ---------------------------------------------------------------------------
// Local transcription (whisper.cpp), degrading gracefully when absent
// ---------------------------------------------------------------------------

fn whisper_configured() -> bool {
    std::env::var("WHISPER_CPP_BIN").is_ok() && std::env::var("WHISPER_MODEL").is_ok()
}

#[tauri::command]
pub fn transcribe(audio_path: String, has_audio: bool) -> TranscriptResult {
    if !has_audio {
        return TranscriptResult::unavailable("recording has no audio track");
    }
    if !whisper_configured() {
        return TranscriptResult::unavailable(
            "no local speech recognizer configured (set WHISPER_CPP_BIN and WHISPER_MODEL)",
        );
    }
    match run_whisper(&audio_path) {
        Ok(result) => result,
        Err(err) => TranscriptResult::unavailable(err),
    }
}

fn run_whisper(audio_path: &str) -> Result<TranscriptResult, String> {
    let bin = std::env::var("WHISPER_CPP_BIN").map_err(|_| "missing WHISPER_CPP_BIN")?;
    let model = std::env::var("WHISPER_MODEL").map_err(|_| "missing WHISPER_MODEL")?;

    // whisper.cpp wants 16 kHz mono WAV; extract with the local ffmpeg.
    let temp_dir = std::env::temp_dir();
    let stem = format!("ss-transcribe-{}", std::process::id());
    let wav_path = temp_dir.join(format!("{stem}.wav"));
    let extract = vec![
        "ffmpeg".to_string(),
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-i".to_string(),
        audio_path.to_string(),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-ar".to_string(),
        "16000".to_string(),
        wav_path.to_string_lossy().to_string(),
    ];
    let extract_out = media::run_tool(&extract)?;
    if extract_out.code != 0 {
        return Err("failed to extract audio for transcription".to_string());
    }

    let out_base = temp_dir.join(&stem);
    let started = Instant::now();
    let status = Command::new(bin)
        .args([
            "-m",
            &model,
            "-f",
            &wav_path.to_string_lossy(),
            "-oj",
            "-of",
            &out_base.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    log::debug!("whisper ran in {:?}", started.elapsed());
    if !status.success() {
        return Err("whisper.cpp failed to transcribe".to_string());
    }

    let json_path = out_base.with_extension("json");
    let raw = std::fs::read_to_string(&json_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav_path);
    let _ = std::fs::remove_file(&json_path);

    parse_whisper_json(&raw)
}

fn parse_whisper_json(raw: &str) -> Result<TranscriptResult, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid whisper json: {e}"))?;
    let mut segments = Vec::new();
    let mut text_parts = Vec::new();

    if let Some(items) = value.get("transcription").and_then(|v| v.as_array()) {
        for item in items {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let start = item
                .get("offsets")
                .and_then(|o| o.get("from"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let end = item
                .get("offsets")
                .and_then(|o| o.get("to"))
                .and_then(|v| v.as_u64())
                .unwrap_or(start);
            if !text.is_empty() {
                text_parts.push(text.clone());
                segments.push(TranscriptSegment {
                    start_ms: start,
                    end_ms: end,
                    text,
                });
            }
        }
    }

    Ok(TranscriptResult {
        available: true,
        reason: None,
        language: value
            .get("result")
            .and_then(|r| r.get("language"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        text: text_parts.join(" "),
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisper_json() {
        let raw = r#"{
            "result": {"language": "en"},
            "transcription": [
                {"offsets": {"from": 0, "to": 1200}, "text": " Hello there."},
                {"offsets": {"from": 1200, "to": 2400}, "text": " Local only."}
            ]
        }"#;
        let result = parse_whisper_json(raw).unwrap();
        assert!(result.available);
        assert_eq!(result.language.as_deref(), Some("en"));
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.text, "Hello there. Local only.");
    }

    #[test]
    fn parses_empty_whisper_json() {
        let result = parse_whisper_json(r#"{"transcription":[]}"#).unwrap();
        assert!(result.available);
        assert_eq!(result.text, "");
    }
}
