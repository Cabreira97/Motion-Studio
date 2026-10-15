//! Locating and running the locally-installed ffmpeg/ffprobe.
//!
//! Everything renders on the user's machine. The webview never gets a shell:
//! it may only ask us to run `ffmpeg`/`ffprobe` with an argument list that we
//! validate first (see [`validate_args`]).

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct ProcessOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MediaStream {
    pub codec_type: Option<String>,
    pub codec_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub r_frame_rate: Option<String>,
    #[serde(default)]
    pub avg_frame_rate: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MediaFormat {
    pub duration: Option<String>,
    pub size: Option<String>,
    pub format_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProbeRaw {
    pub streams: Vec<MediaStream>,
    pub format: MediaFormat,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub fps: f64,
    pub has_audio: bool,
    pub has_video: bool,
}

fn exe_name(tool: &str) -> String {
    if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

fn find_on_path(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe_name(tool));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Resolves a tool via an explicit env override, then PATH, then common
/// package-manager install locations.
pub fn resolve_tool(env_key: &str, tool: &str) -> Option<PathBuf> {
    if let Some(override_path) = std::env::var_os(env_key) {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(found) = find_on_path(tool) {
        return Some(found);
    }
    for dir in fallback_dirs(tool) {
        if dir.is_file() {
            return Some(dir);
        }
    }
    None
}

#[cfg(windows)]
fn fallback_dirs(tool: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let packages = PathBuf::from(local).join("Microsoft").join("WinGet").join("Packages");
        if let Ok(entries) = std::fs::read_dir(&packages) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !name.contains("ffmpeg") {
                    continue;
                }
                if let Ok(sub) = std::fs::read_dir(entry.path()) {
                    for s in sub.flatten() {
                        out.push(s.path().join("bin").join(exe_name(tool)));
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn fallback_dirs(tool: &str) -> Vec<PathBuf> {
    ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .map(|dir| PathBuf::from(dir).join(tool))
        .collect()
}

pub fn ffmpeg_path() -> Result<PathBuf, String> {
    resolve_tool("FFMPEG_PATH", "ffmpeg").ok_or_else(|| {
        "ffmpeg was not found. Install it (winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg) or set FFMPEG_PATH in your .env.".to_string()
    })
}

pub fn ffprobe_path() -> Result<PathBuf, String> {
    resolve_tool("FFPROBE_PATH", "ffprobe")
        .ok_or_else(|| "ffprobe was not found. Install ffmpeg or set FFPROBE_PATH.".to_string())
}

/// Only `ffmpeg` / `ffprobe` may be executed, and only with well-formed args.
pub fn validate_args(args: &[String]) -> Result<(), String> {
    let tool = args.first().ok_or_else(|| "empty argv".to_string())?;
    let stem = std::path::Path::new(tool)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(tool)
        .to_ascii_lowercase();
    if stem != "ffmpeg" && stem != "ffprobe" {
        return Err(format!("refusing to run unexpected tool: {tool}"));
    }
    if args.len() > 20_000 {
        return Err("argument list too long".to_string());
    }
    for arg in args {
        if arg.contains('\u{0}') {
            return Err("arguments may not contain NUL bytes".to_string());
        }
    }
    Ok(())
}

fn apply_win_flags(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Runs a validated ffmpeg/ffprobe invocation and captures its output.
pub fn run_tool(args: &[String]) -> Result<ProcessOutput, String> {
    validate_args(args)?;
    let tool = &args[0];
    let stem = std::path::Path::new(tool)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(tool)
        .to_ascii_lowercase();
    let binary = if stem == "ffprobe" {
        ffprobe_path()?
    } else {
        ffmpeg_path()?
    };

    let mut cmd = Command::new(binary);
    cmd.args(&args[1..]);
    apply_win_flags(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn {}: {e}", binary.display()))?;

    Ok(ProcessOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

pub fn parse_fps(raw: &Option<String>) -> f64 {
    let Some(value) = raw else { return 30.0 };
    let mut parts = value.split('/');
    let num: f64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let den: f64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    if den == 0.0 || num == 0.0 {
        30.0
    } else {
        num / den
    }
}

/// Probes a media file and derives the fields the app cares about.
pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let args = vec![
        "ffprobe".to_string(),
        "-v".to_string(),
        "error".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        path.to_string(),
    ];
    let output = run_tool(&args)?;
    if output.code != 0 {
        return Err(format!("ffprobe failed: {}", output.stderr.trim()));
    }
    let raw: ProbeRaw =
        serde_json::from_str(&output.stdout).map_err(|e| format!("invalid ffprobe json: {e}"))?;

    let video = raw.streams.iter().find(|s| s.codec_type.as_deref() == Some("video"));
    let audio = raw.streams.iter().find(|s| s.codec_type.as_deref() == Some("audio"));
    let duration_ms = raw
        .format
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .map(|s| (s * 1000.0).round() as u64)
        .unwrap_or(0);

    Ok(MediaInfo {
        width: video.and_then(|v| v.width).unwrap_or(0),
        height: video.and_then(|v| v.height).unwrap_or(0),
        duration_ms,
        fps: video.map(|v| parse_fps(&v.r_frame_rate)).unwrap_or(30.0),
        has_audio: audio.is_some(),
        has_video: video.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unexpected_tools() {
        assert!(validate_args(&["rm".to_string(), "-rf".to_string()]).is_err());
        assert!(validate_args(&["sh".to_string()]).is_err());
    }

    #[test]
    fn accepts_ffmpeg_and_ffprobe() {
        assert!(validate_args(&["ffmpeg".to_string(), "-version".to_string()]).is_ok());
        assert!(validate_args(&["ffprobe".to_string(), "in.mp4".to_string()]).is_ok());
        assert!(validate_args(&["C:/tools/ffmpeg.exe".to_string()]).is_ok());
        assert!(validate_args(&["ffmpeg.exe".to_string()]).is_ok());
    }

    #[test]
    fn rejects_empty_and_nul() {
        assert!(validate_args(&[]).is_err());
        assert!(validate_args(&["ffmpeg".to_string(), "a\u{0}b".to_string()]).is_err());
    }

    #[test]
    fn parses_frame_rates() {
        assert_eq!(parse_fps(&Some("30/1".to_string())), 30.0);
        assert!((parse_fps(&Some("30000/1001".to_string())) - 29.97).abs() < 0.01);
        assert_eq!(parse_fps(&None), 30.0);
        assert_eq!(parse_fps(&Some("0/0".to_string())), 30.0);
    }
}
