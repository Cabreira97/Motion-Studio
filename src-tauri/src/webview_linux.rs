//! WebKitGTK tuning needed to play back a recording (Linux/BSD only).
//!
//! WebKitGTK decodes video into a GL sink by default, and on this stack the
//! decoded frames never reach compositing: a `<video>` element reports
//! `readyState: 4`, the right size and an advancing `currentTime`, and shows
//! nothing. Measured on webkit2gtk-4.1 with a canvas copy of the playing
//! element — mean channel value `0` for VP9, against `55.7` for the same file
//! with the sink disabled, and `124.3`/`121.9` for synthetic VP9 and H.264
//! clips. The editor preview is a plain `<video>`, so this is the difference
//! between seeing the recording and seeing a black rectangle.
//!
//! `WEBKIT_GST_DISABLE_GL_SINK=1` routes playback through the software sink
//! instead. It used to be unusable here: it also stops `MediaStream` frames
//! from arriving at all, which broke webview capture outright (148 black frames
//! became zero frames). That no longer matters, because capture on this
//! platform does not go through the webview at all — see `native_capture`.
//!
//! An environment variable is the only knob WebKitGTK exposes for this; there
//! is no setting on `WebView` or `Settings`. It has to be set before the
//! webview builds its playback pipeline, so it is set at the top of `run()`.

/// Points WebKitGTK's video playback at the software sink.
///
/// An existing value is left alone, so the behaviour stays debuggable from the
/// shell: `WEBKIT_GST_DISABLE_GL_SINK=0 pnpm tauri dev` reproduces the black
/// preview this works around.
pub fn prefer_software_video_sink() {
    const VAR: &str = "WEBKIT_GST_DISABLE_GL_SINK";
    if std::env::var_os(VAR).is_none() {
        std::env::set_var(VAR, "1");
    }
}
