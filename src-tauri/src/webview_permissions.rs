//! WebKitGTK capture permissions (Linux/BSD only).
//!
//! On Linux the webview is WebKitGTK, which asks the embedding application for
//! permission before letting a page call `getUserMedia`/`getDisplayMedia`. It
//! does that through the `permission-request` signal, and when nothing is
//! connected the default is **deny** — the page then sees a bare
//! `NotAllowedError` ("The request is not allowed by the user agent or the
//! platform in the current context"), with no dialog ever shown.
//!
//! Tauri does not connect that signal, so screen recording cannot start at all
//! on Linux until we do it here.
//!
//! Allowing the request is not the same as granting capture. For the screen it
//! only lets WebKit open an xdg-desktop-portal ScreenCast session; the desktop
//! portal still shows its own picker and the user still has to choose a
//! surface and confirm. For the microphone there is no portal step, so this
//! does grant the mic — but only while the user is starting a recording with
//! the microphone toggle already enabled in the app's own UI, and nothing here
//! records on its own.
//!
//! Only media requests are allowed. Everything else (notifications,
//! geolocation, ...) falls through to WebKit's default, which is to deny.

use tauri::{AppHandle, Manager, Runtime};

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window.with_webview(|webview| {
        use webkit2gtk::glib::prelude::*;
        use webkit2gtk::{
            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt,
        };

        let view = webview.inner();

        // `getDisplayMedia` is only exposed when media-stream support is on.
        // Tauri enables it already; set it anyway so the signal below is not
        // connected to a webview that can never fire it.
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }

        view.connect_permission_request(|_, request| {
            if request.is::<UserMediaPermissionRequest>() {
                request.allow();
                return true; // handled
            }
            false // let WebKit apply its default (deny)
        });
    })
}
