//! Capture-adjacent helpers: OS cursor sampling (for auto-zoom), reveal-in-
//! folder, and capability reporting so the UI can disable what a platform
//! cannot do instead of failing silently.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CursorSample {
    /// Milliseconds since sampling started.
    pub t: u64,
    /// Normalized 0..1 within the primary display.
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilities {
    pub screen: bool,
    pub window: bool,
    pub region: bool,
    pub microphone: bool,
    pub cursor_sampling: bool,
    pub backend: String,
}

pub fn capabilities() -> CaptureCapabilities {
    CaptureCapabilities {
        screen: true,
        window: true,
        region: true,
        microphone: true,
        cursor_sampling: cfg!(any(windows, target_os = "macos")),
        backend: "webview getDisplayMedia + ffmpeg (local)".to_string(),
    }
}

#[cfg(windows)]
fn cursor_position() -> Option<(f64, f64)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok != 0 {
        Some((point.x as f64, point.y as f64))
    } else {
        None
    }
}

#[cfg(windows)]
fn primary_screen_size() -> (f64, f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let width = unsafe { GetSystemMetrics(SM_CXSCREEN) } as f64;
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN) } as f64;
    (width.max(1.0), height.max(1.0))
}

#[cfg(target_os = "macos")]
fn cursor_position() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let location = event.location();
    Some((location.x, location.y))
}

#[cfg(target_os = "macos")]
fn primary_screen_size() -> (f64, f64) {
    use core_graphics::display::CGDisplay;
    let main = CGDisplay::main();
    (main.pixels_wide() as f64, main.pixels_high() as f64)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn cursor_position() -> Option<(f64, f64)> {
    None
}

#[cfg(not(any(windows, target_os = "macos")))]
fn primary_screen_size() -> (f64, f64) {
    (1.0, 1.0)
}

/// Samples the OS cursor on a background thread while a recording is running.
#[derive(Clone)]
pub struct CursorSampler {
    running: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<CursorSample>>>,
}

impl Default for CursorSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl CursorSampler {
    pub fn new() -> Self {
        CursorSampler {
            running: Arc::new(AtomicBool::new(false)),
            samples: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn is_supported(&self) -> bool {
        cfg!(any(windows, target_os = "macos"))
    }

    pub fn start(&self, interval_ms: u64) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.samples.lock().unwrap().clear();
        let running = self.running.clone();
        let samples = self.samples.clone();
        let interval = interval_ms.clamp(16, 250);

        std::thread::spawn(move || {
            let start = Instant::now();
            let (screen_w, screen_h) = primary_screen_size();
            while running.load(Ordering::SeqCst) {
                if let Some((x, y)) = cursor_position() {
                    let sample = CursorSample {
                        t: start.elapsed().as_millis() as u64,
                        x: (x / screen_w).clamp(0.0, 1.0),
                        y: (y / screen_h).clamp(0.0, 1.0),
                    };
                    if let Ok(mut guard) = samples.lock() {
                        // Throttle: only record when the cursor moved.
                        let keep = match guard.last() {
                            Some(prev) => {
                                let moved = (prev.x - sample.x).abs() + (prev.y - sample.y).abs();
                                moved > 0.002 || sample.t.saturating_sub(prev.t) >= 250
                            }
                            None => true,
                        };
                        if keep {
                            guard.push(sample);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(interval));
            }
        });
    }

    pub fn stop(&self) -> Vec<CursorSample> {
        self.running.store(false, Ordering::SeqCst);
        let taken = self.samples.lock().map(|mut s| std::mem::take(&mut *s));
        taken.unwrap_or_default()
    }
}

/// Reveals a file in the platform file manager (no cloud, no upload).
pub fn reveal_in_folder(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let dir = p.parent().unwrap_or(p);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_are_reported() {
        let caps = capabilities();
        assert!(caps.screen && caps.window && caps.region && caps.microphone);
    }

    #[test]
    fn sampler_start_stop_is_idempotent() {
        let sampler = CursorSampler::new();
        sampler.start(50);
        sampler.start(50); // second start is a no-op
        let samples = sampler.stop();
        // The result is a valid (possibly empty) vector of normalized samples.
        for s in samples {
            assert!((0.0..=1.0).contains(&s.x));
            assert!((0.0..=1.0).contains(&s.y));
        }
    }

    #[test]
    fn reveal_missing_path_errors() {
        assert!(reveal_in_folder("/definitely/not/here.mov").is_err());
    }
}
