//! Capture-adjacent helpers: OS cursor sampling (for auto-zoom), reveal-in-
//! folder, and capability reporting so the UI can disable what a platform
//! cannot do instead of failing silently.
//!
//! Cursor sampling is the one genuinely per-OS piece. Each platform provides a
//! [`PointerSource`] that reports the captured display rectangle and the
//! pointer position in that display's own pixels; the sampler normalizes to
//! 0..1 and drops anything outside (e.g. the pointer sitting on a second
//! monitor that is not being recorded).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CursorSample {
    /// Milliseconds since sampling started.
    pub t: u64,
    /// Normalized 0..1 within the captured display.
    pub x: f64,
    pub y: f64,
}

/// Who takes the picture. The frontend has to know, because the two backends
/// produce a recording in different shapes: the webview hands back a `Blob` to
/// save, while the native one has already written the file.
pub const VIDEO_BACKEND: &str = if cfg!(all(unix, not(target_os = "macos"))) {
    "native"
} else {
    "webview"
};

/// A recording the native backend has already written to disk.
///
/// Lives here rather than in `native_capture` so the command signature is the
/// same on every platform, which `tauri::generate_handler!` requires — it
/// cannot take `#[cfg]` on its entries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecording {
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Frames written to the encoder. Paced against the clock, so this is the
    /// duration times the frame rate.
    pub frames: u64,
    /// Frames the compositor delivered. Fewer than `frames` on a still screen
    /// and more on a busy one; zero means no picture was ever captured.
    pub delivered: u64,
    pub has_audio: bool,
    /// Where the pointer was, over the recording's own timeline.
    ///
    /// Comes from the capture stream rather than from [`CursorSampler`]: on
    /// Wayland no client can read the global pointer position, and the portal
    /// reporting it per frame is the only source there. Empty when the portal
    /// would not report it, in which case the frontend falls back to the
    /// sampler's track.
    pub cursor: Vec<CursorSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilities {
    pub screen: bool,
    pub window: bool,
    pub region: bool,
    pub microphone: bool,
    pub cursor_sampling: bool,
    /// Why cursor sampling is unavailable, when it is. Shown in the UI.
    pub cursor_note: Option<String>,
    pub backend: String,
    /// `"native"` or `"webview"`. Decides which recorder the frontend drives.
    pub video_backend: String,
}

pub fn capabilities() -> CaptureCapabilities {
    let cursor = probe_cursor();
    CaptureCapabilities {
        screen: true,
        window: true,
        region: true,
        microphone: true,
        cursor_sampling: cursor.is_ok(),
        cursor_note: cursor.err(),
        backend: if VIDEO_BACKEND == "native" {
            "xdg-desktop-portal + PipeWire + ffmpeg (local)".to_string()
        } else {
            "webview getDisplayMedia + ffmpeg (local)".to_string()
        },
        video_backend: VIDEO_BACKEND.to_string(),
    }
}

/// The display being sampled, in that display's own pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl DisplayRect {
    /// Normalizes an absolute pointer position into 0..1, or `None` when the
    /// pointer is outside this display (a second monitor, for instance).
    pub fn normalize(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        if self.width <= 0.0 || self.height <= 0.0 {
            return None;
        }
        let nx = (x - self.x) / self.width;
        let ny = (y - self.y) / self.height;
        if !(0.0..=1.0).contains(&nx) || !(0.0..=1.0).contains(&ny) {
            return None;
        }
        Some((nx, ny))
    }
}

/// A per-OS pointer reader. Created inside the sampling thread so platform
/// handles (an X11 display connection, for instance) are opened once and never
/// shared across threads.
pub trait PointerSource {
    fn rect(&self) -> DisplayRect;
    /// Absolute pointer position in the same pixel space as [`Self::rect`].
    fn position(&self) -> Option<(f64, f64)>;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
struct WinPointer {
    rect: DisplayRect,
}

#[cfg(windows)]
impl PointerSource for WinPointer {
    fn rect(&self) -> DisplayRect {
        self.rect
    }

    fn position(&self) -> Option<(f64, f64)> {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return None;
        }
        Some((point.x as f64, point.y as f64))
    }
}

/// Tauri marks the process per-monitor DPI aware, so `GetCursorPos` and
/// `GetSystemMetrics` both report physical pixels and agree with each other.
/// The primary monitor always sits at the virtual-desktop origin.
#[cfg(windows)]
fn open_pointer() -> Result<Box<dyn PointerSource>, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let width = unsafe { GetSystemMetrics(SM_CXSCREEN) } as f64;
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN) } as f64;
    if width <= 0.0 || height <= 0.0 {
        return Err("Windows reported an empty primary display".to_string());
    }
    Ok(Box::new(WinPointer {
        rect: DisplayRect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
    }))
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
struct MacPointer {
    rect: DisplayRect,
}

#[cfg(target_os = "macos")]
impl PointerSource for MacPointer {
    fn rect(&self) -> DisplayRect {
        self.rect
    }

    fn position(&self) -> Option<(f64, f64)> {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let event = CGEvent::new(source).ok()?;
        let location = event.location();
        Some((location.x, location.y))
    }
}

#[cfg(target_os = "macos")]
fn open_pointer() -> Result<Box<dyn PointerSource>, String> {
    use core_graphics::display::CGDisplay;
    let main = CGDisplay::main();
    let width = main.pixels_wide() as f64;
    let height = main.pixels_high() as f64;
    if width <= 0.0 || height <= 0.0 {
        return Err("macOS reported an empty main display".to_string());
    }
    Ok(Box::new(MacPointer {
        rect: DisplayRect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
    }))
}

// ---------------------------------------------------------------------------
// Linux / X11
// ---------------------------------------------------------------------------

/// X11 pointer reader. `XOpenDisplay` is expensive, so the connection is held
/// open for the lifetime of the recording and closed on drop.
#[cfg(all(unix, not(target_os = "macos")))]
struct X11Pointer {
    xlib: x11_dl::xlib::Xlib,
    display: *mut x11_dl::xlib::Display,
    root: x11_dl::xlib::Window,
    rect: DisplayRect,
}

#[cfg(all(unix, not(target_os = "macos")))]
impl PointerSource for X11Pointer {
    fn rect(&self) -> DisplayRect {
        self.rect
    }

    fn position(&self) -> Option<(f64, f64)> {
        let mut root_return: x11_dl::xlib::Window = 0;
        let mut child_return: x11_dl::xlib::Window = 0;
        let mut root_x = 0i32;
        let mut root_y = 0i32;
        let mut win_x = 0i32;
        let mut win_y = 0i32;
        let mut mask = 0u32;
        // SAFETY: `display` and `root` stay valid for this struct's lifetime,
        // and every out-param is an initialized local.
        let found = unsafe {
            (self.xlib.XQueryPointer)(
                self.display,
                self.root,
                &mut root_return,
                &mut child_return,
                &mut root_x,
                &mut root_y,
                &mut win_x,
                &mut win_y,
                &mut mask,
            )
        };
        if found == 0 {
            // The pointer is on a different X screen.
            return None;
        }
        Some((root_x as f64, root_y as f64))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
impl Drop for X11Pointer {
    fn drop(&mut self) {
        // SAFETY: opened by `open_pointer` and closed exactly once, here.
        unsafe {
            (self.xlib.XCloseDisplay)(self.display);
        }
    }
}

/// Wayland deliberately hides the global pointer position from clients, so it
/// has no equivalent of `XQueryPointer`. Under XWayland the call "succeeds"
/// but only tracks motion over XWayland surfaces, which would produce a
/// plausible-looking yet wrong zoom track — so refuse instead of guessing.
///
/// This is not the end of the story on Wayland: the screen-capture portal will
/// report the pointer per frame if it supports metadata cursor mode, which is
/// why [`probe_cursor`] asks it first and only falls back here.
#[cfg(all(unix, not(target_os = "macos")))]
fn wayland_session() -> bool {
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    session_type.eq_ignore_ascii_case("wayland") || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_pointer() -> Result<Box<dyn PointerSource>, String> {
    use x11_dl::xlib;

    if wayland_session() {
        return Err(
            "Wayland does not expose the global cursor position to applications, and this \
             desktop's screen-capture portal will not report it either, so auto-zoom cannot \
             follow the cursor. Use manual zoom in the editor to place zoom moments yourself, \
             or log into an X11/Xorg session to enable cursor following."
                .to_string(),
        );
    }

    let xlib = xlib::Xlib::open().map_err(|e| format!("could not load libX11: {e}"))?;
    // SAFETY: a null display name asks Xlib to use $DISPLAY; the result is
    // checked for null before use.
    let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
    if display.is_null() {
        return Err("could not open the X11 display (is DISPLAY set?)".to_string());
    }

    // SAFETY: `display` is non-null here and owned by the X11Pointer below.
    let (root, width, height) = unsafe {
        let screen = (xlib.XDefaultScreen)(display);
        let root = (xlib.XRootWindow)(display, screen);
        let width = (xlib.XDisplayWidth)(display, screen) as f64;
        let height = (xlib.XDisplayHeight)(display, screen) as f64;
        (root, width, height)
    };

    if width <= 0.0 || height <= 0.0 {
        // SAFETY: closing the display we just opened, before discarding it.
        unsafe { (xlib.XCloseDisplay)(display) };
        return Err("X11 reported an empty screen".to_string());
    }

    Ok(Box::new(X11Pointer {
        xlib,
        display,
        root,
        rect: DisplayRect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
    }))
}

// ---------------------------------------------------------------------------
// Other platforms
// ---------------------------------------------------------------------------

#[cfg(not(any(windows, unix)))]
fn open_pointer() -> Result<Box<dyn PointerSource>, String> {
    Err("cursor sampling is not implemented on this platform".to_string())
}

/// Cheap capability probe: opens a pointer source and immediately drops it.
fn probe_pointer() -> Result<(), String> {
    open_pointer().map(|_| ())
}

/// Whether a cursor track can be recorded at all, and why not when it cannot.
///
/// Two unrelated sources answer this. Where capture is native the cursor comes
/// from the capture stream itself — the portal reports the pointer per frame,
/// which is the only way to learn it on Wayland — and the `XQueryPointer` path
/// below is irrelevant. That path is still the fallback, because a portal that
/// cannot do metadata cursor mode leaves nothing else.
fn probe_cursor() -> Result<(), String> {
    #[cfg(all(unix, not(target_os = "macos")))]
    if crate::native_capture::cursor_metadata_available() {
        return Ok(());
    }
    probe_pointer()
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

    /// Whether a cursor track can be recorded at all — by this sampler or by
    /// the capture backend. Answers what `capture_capabilities` answers, so
    /// `get_app_info` cannot disagree with it.
    pub fn is_supported(&self) -> bool {
        probe_cursor().is_ok()
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
            // Opened inside the thread: platform handles are not Send.
            let source = match open_pointer() {
                Ok(source) => source,
                Err(reason) => {
                    log::info!("cursor sampling unavailable: {reason}");
                    running.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let start = Instant::now();
            let rect = source.rect();
            while running.load(Ordering::SeqCst) {
                if let Some((x, y)) = source.position().and_then(|(x, y)| rect.normalize(x, y)) {
                    let sample = CursorSample {
                        t: start.elapsed().as_millis() as u64,
                        x,
                        y,
                    };
                    if let Ok(mut guard) = samples.lock() {
                        if keep_sample(guard.last(), &sample) {
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

/// Throttle: record a sample when the cursor actually moved, plus a heartbeat
/// every 250 ms so long dwells still anchor the zoom timeline.
///
/// Shared with the native backend, which produces its track from the capture
/// stream rather than from this sampler — the editor reads one shape of track
/// and it should be thinned the same way whichever side filled it.
pub(crate) fn keep_sample(previous: Option<&CursorSample>, next: &CursorSample) -> bool {
    match previous {
        Some(prev) => {
            let moved = (prev.x - next.x).abs() + (prev.y - next.y).abs();
            moved > 0.002 || next.t.saturating_sub(prev.t) >= 250
        }
        None => true,
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
            .map_err(|e| {
                format!("could not open a file manager with xdg-open ({e}) — install xdg-utils")
            })?;
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
        // Sampling may legitimately be unavailable (headless CI, Wayland), but
        // then it must say why so the UI can explain instead of going quiet.
        assert_eq!(caps.cursor_sampling, caps.cursor_note.is_none());
    }

    #[test]
    fn normalizes_inside_the_display() {
        let rect = DisplayRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(rect.normalize(960.0, 540.0), Some((0.5, 0.5)));
        assert_eq!(rect.normalize(0.0, 0.0), Some((0.0, 0.0)));
        assert_eq!(rect.normalize(1920.0, 1080.0), Some((1.0, 1.0)));
    }

    #[test]
    fn drops_samples_from_other_monitors() {
        let rect = DisplayRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        // A second monitor to the right, and one above.
        assert_eq!(rect.normalize(2500.0, 400.0), None);
        assert_eq!(rect.normalize(400.0, -200.0), None);
    }

    #[test]
    fn normalizes_against_a_non_origin_display() {
        let rect = DisplayRect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(rect.normalize(-960.0, 540.0), Some((0.5, 0.5)));
        assert_eq!(rect.normalize(10.0, 540.0), None);
    }

    #[test]
    fn empty_display_normalizes_to_nothing() {
        let rect = DisplayRect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        assert_eq!(rect.normalize(0.0, 0.0), None);
    }

    #[test]
    fn throttles_still_cursors_but_keeps_a_heartbeat() {
        let first = CursorSample {
            t: 0,
            x: 0.5,
            y: 0.5,
        };
        assert!(keep_sample(None, &first));
        // Same spot, 40 ms later: dropped.
        assert!(!keep_sample(
            Some(&first),
            &CursorSample {
                t: 40,
                x: 0.5,
                y: 0.5
            }
        ));
        // Same spot, 250 ms later: heartbeat.
        assert!(keep_sample(
            Some(&first),
            &CursorSample {
                t: 250,
                x: 0.5,
                y: 0.5
            }
        ));
        // Moved: kept.
        assert!(keep_sample(
            Some(&first),
            &CursorSample {
                t: 40,
                x: 0.6,
                y: 0.5
            }
        ));
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
