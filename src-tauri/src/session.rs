//! Recording session timer + system tray.
//!
//! The timer keeps an always-visible elapsed counter (window title + tray
//! tooltip) and the tray exposes a "Stop recording" item that emits an event
//! so the webview can stop its MediaRecorder even when it is unfocused.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct TickPayload {
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Clone)]
pub struct Session {
    running: Arc<AtomicBool>,
    started: Arc<std::sync::Mutex<Option<Instant>>>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Session {
            running: Arc::new(AtomicBool::new(false)),
            started: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started
            .lock()
            .ok()
            .and_then(|guard| guard.map(|start| start.elapsed().as_millis() as u64))
            .unwrap_or(0)
    }

    /// Starts the timer and begins emitting `recording://tick` events.
    pub fn start(&self, app: AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut guard) = self.started.lock() {
            *guard = Some(Instant::now());
        }
        let _ = app.emit("recording://started", ());

        let running = self.running.clone();
        let started = self.started.clone();
        std::thread::spawn(move || {
            let mut last_title = Instant::now() - Duration::from_secs(10);
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let elapsed = started
                    .lock()
                    .ok()
                    .and_then(|guard| guard.map(|s| s.elapsed().as_millis() as u64))
                    .unwrap_or(0);

                let _ = app.emit("recording://tick", TickPayload { elapsed_ms: elapsed });

                // Throttle window-title / tray-tooltip updates to ~1Hz.
                if last_title.elapsed() >= Duration::from_millis(1000) {
                    last_title = Instant::now();
                    let stamp = format_clock(elapsed);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_title(&format!("● REC {stamp}"));
                    }
                    if let Some(tray) = app.try_state::<TrayHandle>() {
                        if let Some(icon) = tray.0.lock().ok().and_then(|g| g.clone()) {
                            let _ = icon.set_tooltip(Some(&format!("Recording {stamp}")));
                        }
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Frame Studio");
            }
            let _ = app.emit("recording://stopped", ());
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

pub fn format_clock(ms: u64) -> String {
    let total_tenths = ms / 100;
    let tenths = total_tenths % 10;
    let total_seconds = total_tenths / 10;
    let seconds = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = total_seconds / 3600;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}.{tenths}")
    } else {
        format!("{minutes:02}:{seconds:02}.{tenths}")
    }
}

/// Wrapper so the tray handle can live in Tauri's managed state.
#[derive(Default)]
pub struct TrayHandle(pub std::sync::Mutex<Option<TrayIcon>>);

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let stop = MenuItem::with_id(app, "stop", "Stop recording", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Frame Studio", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&stop, &show, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Frame Studio")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "stop" => {
                let _ = app.emit("recording://stop-requested", ());
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder.build(app)?;
    app.manage(TrayHandle(std::sync::Mutex::new(Some(tray))));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_clock() {
        assert_eq!(format_clock(0), "00:00.0");
        assert_eq!(format_clock(12_300), "00:12.3");
        assert_eq!(format_clock(62_500), "01:02.5");
        assert_eq!(format_clock(3_600_000), "1:00:00.0");
    }

    #[test]
    fn session_starts_and_stops() {
        let session = Session::new();
        assert!(!session.is_running());
        session.stop();
        assert!(!session.is_running());
        assert_eq!(session.elapsed_ms(), 0);
    }
}
