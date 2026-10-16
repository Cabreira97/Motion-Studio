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

/// Makes WebKitGTK decode video into frames a canvas can read back.
///
/// By default WebKitGTK gives its GStreamer media pipeline a GL video sink, and
/// the frames it produces are GPU-side handles. The element plays — `readyState`
/// reaches 4 and `getVideoPlaybackQuality().totalVideoFrames` climbs — but
/// `drawImage(video, ...)` reads back solid black, silently. For this app that
/// is fatal rather than cosmetic: the screen capture is routed through a canvas
/// (see `frame-bridge.ts`), so every recording came out black while reporting
/// success, at 1920x1080 and 30fps with a correct frame count.
///
/// Measured in this exact engine against a file video, which uses the same
/// pipeline a PipeWire screen capture does: with the GL sink, 0 of 2304 sampled
/// pixels were lit; with it disabled, 2010 of 2304, mean luma 214. Element
/// visibility made no difference in either case, so this is the sink and not a
/// hidden-video optimisation.
///
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes it too, but that turns off
/// accelerated rendering for the whole webview. This one is scoped to the media
/// pipeline, which is the only part that needs to change.
///
/// Must run before the webview is created, so GStreamer reads it during setup.
/// An existing value is left alone, so the choice stays overridable.
pub fn prefer_readable_video_frames() {
    const KEY: &str = "WEBKIT_GST_DISABLE_GL_SINK";
    if std::env::var_os(KEY).is_none() {
        std::env::set_var(KEY, "1");
    }
}

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
