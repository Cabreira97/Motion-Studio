//! Native screen capture for Linux/BSD: xdg-desktop-portal ScreenCast into
//! PipeWire into ffmpeg.
//!
//! The webview cannot capture here. Measured on real hardware, WebKitGTK's
//! display track encodes to zero frames, and when its frames are copied through
//! a canvas they read back as solid black — through a 2D context and through
//! WebGL alike, with the saved file reporting `YAVG=16` (limited-range black)
//! on every frame. There is no engine-side switch that fixes it: disabling the
//! GL sink makes file video readable but stops MediaStream frames arriving at
//! all. So on Linux the picture is taken natively instead.
//!
//! The path has three stages:
//!
//! 1. **Portal.** `ashpd` asks xdg-desktop-portal for a ScreenCast session over
//!    D-Bus. The compositor shows its own picker, and hands back a PipeWire
//!    node id plus a file descriptor for its PipeWire connection. This is also
//!    where the capture mode is chosen, and the portal reports what it actually
//!    supports, so a mode is never offered that would be refused later.
//! 2. **PipeWire.** A stream connects to that node and receives frames as
//!    mapped buffers. Negotiation is restricted to packed RGB formats so each
//!    one maps to a single ffmpeg `-pix_fmt` with no plane arithmetic.
//! 3. **ffmpeg.** Frames go in on stdin as `rawvideo`. ffmpeg is already a hard
//!    requirement of this app, and the one here has no PipeWire input anyway:
//!    only `kmsgrab`, which needs `CAP_SYS_ADMIN`, and `x11grab`, which cannot
//!    see a native Wayland session.
//!
//! Two properties of the source shape the rest of this module:
//!
//! * **The frame rate is variable.** The portal negotiates `framerate=0/1`: the
//!   compositor sends a frame when the screen changes, which on an idle desktop
//!   measured 315 frames in 6 seconds and on a still one would be none at all.
//!   Frames are therefore paced against the wall clock on the way out, so the
//!   file's duration matches the time that actually passed.
//! * **Writing to ffmpeg must not happen on the PipeWire loop.** Encoding is
//!   slower than capture, and a blocking write would stall the loop and drop
//!   frames at the source — which would then look like a capture problem.
//!
//! The portal is also the only place the pointer can be observed. Wayland hides
//! the global cursor position from every client, so `XQueryPointer` has no
//! equivalent and cursor-following zoom had nothing to follow. Asking for
//! `CursorMode::Metadata` makes the compositor report the pointer per frame —
//! at the cost of no longer drawing it, so the cursor bitmap is blended into
//! the picture here instead.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ashpd::desktop::PersistMode;
use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::enumflags2::BitFlags;
use pipewire as pw;
use pw::{properties::properties, spa};
use crate::capture::{CursorSample, NativeRecording, keep_sample};

/// How long to wait for the user to answer the portal picker before giving up.
///
/// Generous on purpose: the only thing happening during this window is a human
/// reading a dialog. Shorter would turn a slow decision into a failed capture.
const PICKER_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to wait for the first frame once the share is approved.
///
/// Past this, the stream is live but producing nothing, which is a real failure
/// and not a slow start. Reported rather than recorded, because a capture that
/// silently yields nothing is exactly the bug this module replaces.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the portal to say which cursor modes it supports.
///
/// This runs during a capability query, not a recording, so a portal that is
/// slow to answer must not hold up the UI. Answering "no" early only costs the
/// cursor-following zoom option, which the user can still place by hand.
const CURSOR_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The largest cursor bitmap this capture accepts, per edge.
///
/// A budget rather than a sanity check: the same number sizes the metadata
/// PipeWire allocates on every buffer, so it is paid per frame. 128x128 covers
/// the largest cursor themes in practice and costs 64 KiB a buffer.
const MAX_CURSOR_EDGE: u32 = 128;

/// Upper bound on recorded pointer positions, about 4 MiB of them.
///
/// The source rate is the compositor's, not ours, and a long recording on a
/// busy screen would otherwise grow this without limit. Hitting the cap loses
/// the tail of the cursor track, which degrades the zoom; growing without
/// bound would lose the recording.
const MAX_CURSOR_MOMENTS: usize = 200_000;

/// What to point the portal at. The region crop is applied later, on export, so
/// it captures a whole monitor like `Screen` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureKind {
    Screen,
    Window,
    Region,
}

impl CaptureKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "screen" => Ok(Self::Screen),
            "window" => Ok(Self::Window),
            "region" => Ok(Self::Region),
            other => Err(format!("unknown capture kind: {other}")),
        }
    }

    fn source_type(self) -> SourceType {
        match self {
            Self::Window => SourceType::Window,
            Self::Screen | Self::Region => SourceType::Monitor,
        }
    }
}

/// A negotiated SPA video format mapped to its ffmpeg pixel format and stride.
///
/// Only formats offered during negotiation appear here. An unknown one is an
/// error rather than a guess: feeding ffmpeg the wrong layout yields a file
/// that plays, passes every structural check, and shows the wrong picture.
fn ffmpeg_pix_fmt(format: spa::param::video::VideoFormat) -> Option<(&'static str, usize)> {
    use spa::param::video::VideoFormat as F;
    match format {
        F::BGRx => Some(("bgr0", 4)),
        F::RGBx => Some(("rgb0", 4)),
        F::BGRA => Some(("bgra", 4)),
        F::RGBA => Some(("rgba", 4)),
        _ => None,
    }
}

/// Byte offsets of each channel inside a 4-byte packed pixel.
///
/// SPA format names are in memory order — `BGRx` is byte 0 blue, byte 1 green,
/// byte 2 red, byte 3 unused — which is also how ffmpeg reads `bgr0`. Keeping
/// this as a table rather than branching per format is what lets one blend
/// routine serve the frame and the cursor bitmap at once, which matters because
/// the two arrive in different orders: the frame is typically `BGRx` and the
/// cursor `BGRA`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Channels {
    r: usize,
    g: usize,
    b: usize,
    /// `None` for the `x` formats, which carry no alpha at all.
    a: Option<usize>,
}

fn channels(format: spa::param::video::VideoFormat) -> Option<Channels> {
    use spa::param::video::VideoFormat as F;
    match format {
        F::BGRx => Some(Channels { r: 2, g: 1, b: 0, a: None }),
        F::RGBx => Some(Channels { r: 0, g: 1, b: 2, a: None }),
        F::BGRA => Some(Channels { r: 2, g: 1, b: 0, a: Some(3) }),
        F::RGBA => Some(Channels { r: 0, g: 1, b: 2, a: Some(3) }),
        _ => None,
    }
}

/// A cursor image, unpacked to tightly packed RGBA.
///
/// Cached across frames: the compositor sends the bitmap only when the cursor
/// image changes and sends position alone the rest of the time, so a frame
/// without a bitmap still has to draw the last one. The hotspot travels with
/// the image because it is only meaningful alongside it.
struct CursorBitmap {
    width: usize,
    height: usize,
    /// Where inside the bitmap the pointer actually points.
    hotspot_x: i32,
    hotspot_y: i32,
    /// `width * height * 4`, in R, G, B, A order.
    pixels: Vec<u8>,
}

/// What one frame said about the cursor image.
///
/// Three cases and not two, because "no bitmap in this buffer" and "the cursor
/// has no picture" are different things on the wire and look identical if
/// collapsed: the first has to keep drawing the cached image, the second has to
/// stop. Collapsing them leaves a pointer frozen on screen for the rest of the
/// recording every time the cursor is hidden — while typing, for instance.
enum CursorImage {
    /// `bitmap_offset` was zero: keep whatever was last drawn.
    Unchanged,
    Changed(CursorBitmap),
    /// A bitmap carrying no pixel data at all. The cursor is invisible.
    Hidden,
}

/// What the compositor reported about the pointer on one frame.
struct CursorShot {
    /// Hotspot position in frame pixels — the point the pointer is at.
    x: i32,
    y: i32,
    image: CursorImage,
}

/// A pointer position as it was reported, on the monotonic clock.
///
/// Not yet a [`CursorSample`]: those are timestamped relative to the start of
/// the written file, and that origin is not known until the encoder starts.
struct CursorMoment {
    at: Instant,
    x: f64,
    y: f64,
}

/// The frame being drawn into: packed pixels plus how to read them.
struct FrameView<'a> {
    pixels: &'a mut [u8],
    width: usize,
    height: usize,
    bpp: usize,
    channels: Channels,
}

/// The most recent frame, plus what is needed to interpret it.
///
/// One slot rather than a queue: the writer paces against the clock and only
/// ever wants the newest picture, so queueing would add latency and memory to
/// deliver frames that would be discarded anyway.
struct FrameSlot {
    width: usize,
    height: usize,
    pix_fmt: &'static str,
    /// Tightly packed, `width * bytes_per_pixel` per row. PipeWire pads rows
    /// for alignment; ffmpeg's `rawvideo` demuxer does not expect that padding,
    /// and leaving it in shifts every row after the first.
    pixels: Vec<u8>,
    /// Frames delivered so far. Zero means nothing has arrived yet, which is
    /// what the writer waits on before it starts an encoder.
    delivered: u64,
}

#[derive(Default)]
struct Shared {
    slot: Mutex<Option<FrameSlot>>,
    /// Signals the writer that the first frame landed, so it does not have to
    /// poll for the format it needs to configure ffmpeg.
    arrived: Condvar,
    /// Pointer positions as the compositor reported them. Converted to
    /// recording-relative milliseconds at the end, against the same origin the
    /// encoder paces from — the two clocks have to agree or a cursor-following
    /// zoom drifts away from the picture it is following.
    cursor: Mutex<Vec<CursorMoment>>,
    /// When the encoder started pacing frames: time zero of the written file.
    origin: Mutex<Option<Instant>>,
}

/// Reads the pointer off a captured buffer, copying out what it needs.
///
/// Copying rather than borrowing is forced and useful at once: the metadata
/// borrows the buffer immutably while the frame data borrows it mutably, so the
/// two cannot be held together, and an owned bitmap is what lets it be cached
/// for the frames that carry no new one.
fn read_cursor(buffer: &pw::buffer::Buffer<'_>) -> Option<CursorShot> {
    let meta = buffer.find_meta::<spa::buffer::meta::MetaCursor>()?;
    // An id of zero means this buffer carries no new cursor data at all, which
    // is not the same as the cursor sitting at the origin.
    if !meta.is_valid() {
        return None;
    }
    let position = meta.position();
    let hotspot = meta.hotspot();
    // `MetaCursor::bitmap` is `None` exactly when `bitmap_offset` is zero,
    // which the SPA header defines as "no new bitmap information" — this buffer
    // carries a position and nothing else.
    let image = match meta.bitmap() {
        None => CursorImage::Unchanged,
        // A zero format is also defined as "no new bitmap information", so it
        // has to be ruled out before a zero offset is read as invisible.
        Some(bitmap) if !bitmap.is_valid() => CursorImage::Unchanged,
        Some(bitmap) if bitmap.offset() == 0 => CursorImage::Hidden,
        Some(bitmap) => match read_cursor_bitmap(bitmap, hotspot) {
            Some(parsed) => CursorImage::Changed(parsed),
            // A bitmap that is there but unusable — an unmapped format, or one
            // larger than the budget. Keep the last image rather than blanking
            // the pointer over something this side could not read.
            None => CursorImage::Unchanged,
        },
    };
    Some(CursorShot {
        x: position.x,
        y: position.y,
        image,
    })
}

fn read_cursor_bitmap(
    bitmap: &spa::buffer::meta::MetaBitmap,
    hotspot: spa::utils::Point,
) -> Option<CursorBitmap> {
    let size = bitmap.size();
    if size.width == 0
        || size.height == 0
        || size.width > MAX_CURSOR_EDGE
        || size.height > MAX_CURSOR_EDGE
    {
        return None;
    }
    let source = channels(bitmap.format())?;
    let width = size.width as usize;
    let height = size.height as usize;
    let row = width * 4;
    let reported = bitmap.stride().unsigned_abs() as usize;
    let stride = if reported >= row { reported } else { row };
    let data = bitmap.bitmap_data()?;
    if data.len() < stride * (height - 1) + row {
        return None;
    }

    let mut pixels = vec![0u8; row * height];
    for y in 0..height {
        for x in 0..width {
            let src = y * stride + x * 4;
            let dst = y * row + x * 4;
            pixels[dst] = data[src + source.r];
            pixels[dst + 1] = data[src + source.g];
            pixels[dst + 2] = data[src + source.b];
            pixels[dst + 3] = source.a.map_or(255, |a| data[src + a]);
        }
    }
    Some(CursorBitmap {
        width,
        height,
        hotspot_x: hotspot.x,
        hotspot_y: hotspot.y,
        pixels,
    })
}

/// Alpha-blends a cursor into a packed-RGB frame, in place.
///
/// `at_x`/`at_y` are the pointer position; the hotspot is subtracted here, so
/// the tip of the arrow lands on the pixel the pointer is actually over. The
/// bitmap is treated as premultiplied — the Wayland convention for the
/// `ARGB8888` cursor surfaces the portal's bitmap comes from — so the composite
/// is `dst = src + dst * (1 - a)` with no divide by alpha. Reading it as
/// straight alpha instead draws a bright halo around the pointer.
///
/// Pixels outside the frame are skipped rather than clamped, so a cursor half
/// off the edge of the screen is drawn half.
fn blend_cursor(frame: &mut FrameView<'_>, cursor: &CursorBitmap, at_x: i32, at_y: i32) {
    let origin_x = at_x - cursor.hotspot_x;
    let origin_y = at_y - cursor.hotspot_y;

    for cy in 0..cursor.height {
        let fy = origin_y + cy as i32;
        if fy < 0 || fy as usize >= frame.height {
            continue;
        }
        for cx in 0..cursor.width {
            let fx = origin_x + cx as i32;
            if fx < 0 || fx as usize >= frame.width {
                continue;
            }
            let src = (cy * cursor.width + cx) * 4;
            let alpha = u32::from(cursor.pixels[src + 3]);
            if alpha == 0 {
                continue;
            }
            let dst = fy as usize * frame.width * frame.bpp + fx as usize * frame.bpp;
            let under_weight = 255 - alpha;
            for (offset, channel) in [
                (frame.channels.r, 0usize),
                (frame.channels.g, 1),
                (frame.channels.b, 2),
            ] {
                let over = u32::from(cursor.pixels[src + channel]);
                let under = u32::from(frame.pixels[dst + offset]);
                frame.pixels[dst + offset] =
                    (over + (under * under_weight + 127) / 255).min(255) as u8;
            }
            if let Some(offset) = frame.channels.a {
                let under = u32::from(frame.pixels[dst + offset]);
                frame.pixels[dst + offset] =
                    (alpha + (under * under_weight + 127) / 255).min(255) as u8;
            }
        }
    }
}

/// Turns raw pointer moments into a recording-relative cursor track.
///
/// Timestamps are measured from the encoder's origin so they line up with the
/// frames that were written. Moments from before it — captured while ffmpeg was
/// starting — are pinned to zero rather than dropped, so a zoom that follows
/// the cursor has somewhere to start. The same throttle the OS sampler uses is
/// applied here, on the converted samples, because it needs the timestamps.
fn cursor_track(origin: Option<Instant>, moments: &[CursorMoment]) -> Vec<CursorSample> {
    let Some(origin) = origin else {
        return Vec::new();
    };
    let mut track: Vec<CursorSample> = Vec::with_capacity(moments.len());
    for moment in moments {
        let sample = CursorSample {
            t: moment.at.saturating_duration_since(origin).as_millis() as u64,
            x: moment.x,
            y: moment.y,
        };
        if keep_sample(track.last(), &sample) {
            track.push(sample);
        }
    }
    track
}

/// Whether the portal can report the pointer position as stream metadata.
///
/// This is the only thing that makes cursor-following zoom possible on Wayland,
/// where no client can read the global pointer position. Probed on its own
/// thread with its own runtime: the caller is a synchronous Tauri command that
/// may already be running inside one, and nesting `block_on` panics.
///
/// Cached, because the answer is a property of the installed portal and the
/// check costs a D-Bus round trip on a path the UI queries freely.
pub fn cursor_metadata_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::thread::spawn(|| {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return false;
            };
            runtime.block_on(async {
                let probe = async {
                    let proxy = Screencast::new().await?;
                    proxy.available_cursor_modes().await
                };
                match tokio::time::timeout(CURSOR_PROBE_TIMEOUT, probe).await {
                    Ok(Ok(modes)) => modes.contains(CursorMode::Metadata),
                    _ => false,
                }
            })
        })
        .join()
        .unwrap_or(false)
    })
}

/// A capture in progress.
pub struct Session {
    /// Quits the PipeWire loop from another thread. The loop owns its thread
    /// and `run()` never returns on its own.
    quit: pw::channel::Sender<()>,
    thread: JoinHandle<Result<NativeRecording, String>>,
}

impl Session {
    pub fn stop(self) -> Result<NativeRecording, String> {
        // A send failure means the loop already exited — the thread's own
        // result says why, so it is not an error to report here.
        let _ = self.quit.send(());
        match self.thread.join() {
            Ok(result) => result,
            Err(_) => Err("the capture thread panicked".to_string()),
        }
    }
}

/// Opens the portal, starts capturing, and returns once frames are flowing.
///
/// Blocking until the first frame is deliberate: the UI switches to "recording"
/// on return, and a capture that is still negotiating — or already failing —
/// must not be shown as one that is recording.
pub fn start(
    kind: CaptureKind,
    fps: u32,
    mic: bool,
    output: PathBuf,
    ffmpeg: PathBuf,
) -> Result<Session, String> {
    let fps = fps.clamp(1, 240);
    let shared = Arc::new(Shared::default());
    let (quit_tx, quit_rx) = pw::channel::channel::<()>();
    // Rendezvous with the capture thread: it reports either that the portal
    // refused or that the stream is connected, and only then does this return.
    let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);

    let thread = {
        let shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("native-capture".to_string())
            .spawn(move || capture_thread(kind, fps, mic, output, ffmpeg, shared, quit_rx, ready_tx))
            .map_err(|e| format!("could not start the capture thread: {e}"))?
    };

    match ready_rx.recv_timeout(PICKER_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(message)) => {
            let _ = thread.join();
            return Err(message);
        }
        Err(RecvTimeoutError::Timeout) => {
            let _ = quit_tx.send(());
            let _ = thread.join();
            return Err(format!(
                "the screen picker went unanswered for {}s.",
                PICKER_TIMEOUT.as_secs()
            ));
        }
        Err(RecvTimeoutError::Disconnected) => {
            let message = match thread.join() {
                Ok(Err(message)) => message,
                _ => "the capture thread ended before it started capturing".to_string(),
            };
            return Err(message);
        }
    }

    // The stream is connected, but connected is not producing. Wait for a real
    // frame so that "recording" means pictures are being written.
    wait_for_first_frame(&shared)?;

    Ok(Session {
        quit: quit_tx,
        thread,
    })
}

/// Whether any frame has landed yet. Written out rather than using
/// `Option::is_none_or`, which is newer than this crate's MSRV.
fn has_frame(slot: &Option<FrameSlot>) -> bool {
    match slot {
        Some(slot) => slot.delivered > 0,
        None => false,
    }
}

fn wait_for_first_frame(shared: &Shared) -> Result<(), String> {
    let mut slot = shared
        .slot
        .lock()
        .map_err(|_| "the frame slot was poisoned".to_string())?;
    let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
    while !has_frame(&slot) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "the capture source produced no picture in {}s. The share was approved and the stream connected, but no frame arrived.",
                FIRST_FRAME_TIMEOUT.as_secs()
            ));
        }
        let (next, timeout) = shared
            .arrived
            .wait_timeout(slot, remaining)
            .map_err(|_| "the frame slot was poisoned".to_string())?;
        slot = next;
        if timeout.timed_out() && !has_frame(&slot) {
            return Err(format!(
                "the capture source produced no picture in {}s. The share was approved and the stream connected, but no frame arrived.",
                FIRST_FRAME_TIMEOUT.as_secs()
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn capture_thread(
    kind: CaptureKind,
    fps: u32,
    mic: bool,
    output: PathBuf,
    ffmpeg: PathBuf,
    shared: Arc<Shared>,
    quit_rx: pw::channel::Receiver<()>,
    ready_tx: SyncSender<Result<(), String>>,
) -> Result<NativeRecording, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("could not start the portal runtime: {e}"))?;

    let (node_id, fd, cursor_metadata) = match runtime.block_on(open_portal(kind)) {
        Ok(opened) => opened,
        Err(error) => {
            let message = describe_portal_error(&error);
            let _ = ready_tx.send(Err(message.clone()));
            return Err(message);
        }
    };

    // The writer owns the encoder: it learns the format from the first frame,
    // spawns ffmpeg, then paces frames out against the clock.
    let stop_writer = Arc::new(AtomicBool::new(false));
    let writer = {
        let shared = Arc::clone(&shared);
        let stop_writer = Arc::clone(&stop_writer);
        let output = output.clone();
        std::thread::Builder::new()
            .name("native-capture-encode".to_string())
            .spawn(move || write_frames(shared, stop_writer, fps, mic, output, ffmpeg))
            .map_err(|e| format!("could not start the encoder thread: {e}"))?
    };

    let pipewire_result = run_pipewire(
        node_id,
        fd,
        cursor_metadata,
        Arc::clone(&shared),
        quit_rx,
        &ready_tx,
    );

    stop_writer.store(true, Ordering::Release);
    let written = match writer.join() {
        Ok(result) => result,
        Err(_) => Err("the encoder thread panicked".to_string()),
    };

    pipewire_result?;
    let written = written?;

    let cursor = {
        let origin = *shared
            .origin
            .lock()
            .map_err(|_| "the recording origin was poisoned".to_string())?;
        let moments = shared
            .cursor
            .lock()
            .map_err(|_| "the cursor track was poisoned".to_string())?;
        cursor_track(origin, &moments)
    };

    let slot = shared
        .slot
        .lock()
        .map_err(|_| "the frame slot was poisoned".to_string())?;
    let (width, height, delivered) = match slot.as_ref() {
        Some(slot) => (slot.width as u32, slot.height as u32, slot.delivered),
        None => (0, 0, 0),
    };

    Ok(NativeRecording {
        path: output.to_string_lossy().to_string(),
        width,
        height,
        frames: written,
        delivered,
        has_audio: mic,
        cursor,
    })
}

/// Turns a portal refusal into something a user can act on.
///
/// The portal reports a declined picker and a missing portal service the same
/// way as far as the call site is concerned, and neither message names what the
/// user should do about it.
fn describe_portal_error(error: &ashpd::Error) -> String {
    match error {
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => {
            "Screen capture was cancelled in the system picker.".to_string()
        }
        ashpd::Error::Portal(detail) => format!(
            "The desktop portal refused the capture ({detail}). Check that xdg-desktop-portal and the backend for your desktop are installed and running."
        ),
        other => format!(
            "Could not reach the desktop screen-capture portal ({other}). Screen recording on Linux goes through xdg-desktop-portal; check that it and the backend for your desktop are installed and running."
        ),
    }
}

/// Opens a ScreenCast session.
///
/// The third element of the result says whether the pointer will arrive as
/// stream metadata, which decides both that a cursor track can be recorded and
/// that the cursor has to be drawn into the frame by hand.
async fn open_portal(
    kind: CaptureKind,
) -> ashpd::Result<(u32, std::os::fd::OwnedFd, bool)> {
    let proxy = Screencast::new().await?;

    // Ask what the compositor supports rather than assuming. Window capture is
    // the case that matters: the webview advertised it and then failed with
    // "Invalid constraint" after the user had already picked a surface.
    let available = proxy.available_source_types().await?;
    let wanted = kind.source_type();
    if !available.contains(wanted) {
        return Err(ashpd::Error::Portal(ashpd::PortalError::NotAllowed(
            format!("this desktop cannot capture a {wanted:?}"),
        )));
    }

    // Prefer the pointer as metadata. It is the only way to learn where the
    // cursor is on Wayland, which is what cursor-following zoom needs, and the
    // compositor stops drawing the pointer in exchange — so it gets blended in
    // here instead. `Embedded` keeps the picture right and loses the position;
    // `Hidden` is the last resort of a portal offering neither.
    let modes = proxy.available_cursor_modes().await.unwrap_or_default();
    let cursor_mode = if modes.contains(CursorMode::Metadata) {
        CursorMode::Metadata
    } else if modes.contains(CursorMode::Embedded) || modes.is_empty() {
        // An empty set is a portal too old to publish the property at all;
        // `Embedded` is the mode every version has supported.
        CursorMode::Embedded
    } else {
        CursorMode::Hidden
    };

    let session = proxy.create_session(Default::default()).await?;
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(cursor_mode)
                .set_sources(BitFlags::from(wanted))
                .set_multiple(false)
                .set_restore_token(None)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await?;

    let response = proxy.start(&session, None, Default::default()).await?.response()?;
    let stream = response
        .streams()
        .first()
        .ok_or_else(|| {
            ashpd::Error::Portal(ashpd::PortalError::Failed(
                "the portal approved the capture but returned no stream".to_string(),
            ))
        })?
        .to_owned();

    let fd = proxy.open_pipe_wire_remote(&session, Default::default()).await?;
    Ok((
        stream.pipe_wire_node_id(),
        fd,
        cursor_mode == CursorMode::Metadata,
    ))
}

fn run_pipewire(
    node_id: u32,
    fd: std::os::fd::OwnedFd,
    // Whether the portal granted `CursorMode::Metadata`. When it did, the
    // compositor no longer draws the pointer, so this side has to.
    cursor_metadata: bool,
    shared: Arc<Shared>,
    quit_rx: pw::channel::Receiver<()>,
    ready_tx: &SyncSender<Result<(), String>>,
) -> Result<(), String> {
    pw::init();

    let mainloop =
        pw::main_loop::MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
    let context = pw::context::ContextRc::new(&mainloop, None)
        .map_err(|e| format!("PipeWire context: {e}"))?;
    let core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| format!("PipeWire connection: {e}"))?;

    let stream = pw::stream::StreamBox::new(
        &core,
        "motion-studio-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("PipeWire stream: {e}"))?;

    // The cursor arrives sparsely: a position on most frames, a bitmap only
    // when the image changes. Both are remembered across callbacks so every
    // frame is drawn with the pointer that was last reported, instead of the
    // cursor blinking out between updates.
    let mut cursor_image: Option<CursorBitmap> = None;
    let mut cursor_at: Option<(i32, i32)> = None;

    let _listener = stream
        .add_local_listener_with_user_data(spa::param::video::VideoInfoRaw::default())
        .param_changed(|_, format, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            if let Err(error) = format.parse(param) {
                log::error!("could not parse the negotiated video format: {error}");
            }
        })
        .process(move |stream, format| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };

            // Read the pointer before the frame data: the metadata borrows the
            // buffer immutably and `datas_mut` borrows it mutably.
            let mut moved = None;
            if cursor_metadata {
                if let Some(shot) = read_cursor(&buffer) {
                    match shot.image {
                        CursorImage::Unchanged => {}
                        CursorImage::Changed(bitmap) => cursor_image = Some(bitmap),
                        CursorImage::Hidden => cursor_image = None,
                    }
                    cursor_at = Some((shot.x, shot.y));
                    moved = Some((shot.x, shot.y));
                }
            }

            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else { return };

            let width = format.size().width as usize;
            let height = format.size().height as usize;
            let Some((pix_fmt, bpp)) = ffmpeg_pix_fmt(format.format()) else {
                log::error!("unmapped video format {:?}", format.format());
                return;
            };
            if width == 0 || height == 0 {
                return;
            }

            let chunk_stride = data.chunk().stride() as usize;
            let Some(bytes) = data.data() else {
                // No mapped memory means the buffer arrived as a DMA-BUF handle
                // rather than a CPU copy, which would need an import step. Name
                // it; a silent skip here would look like a dead capture.
                log::error!("a captured frame had no mapped data (dmabuf?)");
                return;
            };

            let row = width * bpp;
            let stride = if chunk_stride >= row { chunk_stride } else { row };
            if bytes.len() < stride * (height - 1) + row {
                return;
            }

            // Record the pointer against the frame it was reported with, which
            // is what makes the track normalized to the same picture the editor
            // zooms into. A position outside the frame is the pointer sitting on
            // another monitor, and is dropped rather than clamped to an edge.
            if let Some((x, y)) = moved {
                if x >= 0 && y >= 0 && (x as usize) < width && (y as usize) < height {
                    if let Ok(mut moments) = shared.cursor.lock() {
                        if moments.len() < MAX_CURSOR_MOMENTS {
                            moments.push(CursorMoment {
                                at: Instant::now(),
                                x: f64::from(x) / width as f64,
                                y: f64::from(y) / height as f64,
                            });
                        }
                    }
                }
            }

            let Ok(mut guard) = shared.slot.lock() else { return };
            let slot = guard.get_or_insert_with(|| FrameSlot {
                width,
                height,
                pix_fmt,
                pixels: vec![0; row * height],
                delivered: 0,
            });
            // A mid-stream resize would make every later row land in the wrong
            // place. Dropping the frame keeps the file consistent; the encoder
            // is already configured for the first size.
            if slot.width != width || slot.height != height || slot.pix_fmt != pix_fmt {
                return;
            }
            for y in 0..height {
                let src = y * stride;
                let dst = y * row;
                slot.pixels[dst..dst + row].copy_from_slice(&bytes[src..src + row]);
            }

            // Metadata cursor mode means the compositor left the pointer out of
            // the picture, so draw it. Every frame, from the last reported
            // position — not only the ones that carried an update, or the cursor
            // would flicker on a screen that is changing faster than it moves.
            if let (Some(image), Some((x, y))) = (cursor_image.as_ref(), cursor_at) {
                if let Some(channels) = channels(format.format()) {
                    blend_cursor(
                        &mut FrameView {
                            pixels: &mut slot.pixels,
                            width,
                            height,
                            bpp,
                            channels,
                        },
                        image,
                        x,
                        y,
                    );
                }
            }

            slot.delivered += 1;
            shared.arrived.notify_all();
        })
        .register()
        .map_err(|e| format!("PipeWire listener: {e}"))?;

    let _quit = {
        let weak = mainloop.downgrade();
        quit_rx.attach(mainloop.loop_(), move |()| {
            if let Some(mainloop) = weak.upgrade() {
                mainloop.quit();
            }
        })
    };

    let format_pod = format_params();
    let meta_pod = cursor_meta_params();
    let mut pods = Vec::with_capacity(2);
    pods.push(spa::pod::Pod::from_bytes(&format_pod).ok_or("malformed format pod")?);
    if cursor_metadata {
        // Only asked for when it will be used: the size below is allocated on
        // every buffer, so requesting it under `Embedded` would pay for a
        // bitmap the compositor already drew.
        pods.push(spa::pod::Pod::from_bytes(&meta_pod).ok_or("malformed cursor metadata pod")?);
    }
    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut pods,
        )
        .map_err(|e| format!("could not connect to the capture stream: {e}"))?;

    // Connected. Anything after this is a capture that started and then went
    // wrong, which is reported through the summary rather than the start call.
    let _ = ready_tx.send(Ok(()));

    mainloop.run();
    Ok(())
}

/// The formats this capture will accept, as a serialized SPA pod.
///
/// Packed RGB only — no I420 or YUY2. Each of these maps to exactly one ffmpeg
/// `-pix_fmt` with no plane arithmetic, so a wrong picture can never be blamed
/// on a conversion done here.
fn format_params() -> Vec<u8> {
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::RGBx,
            spa::param::video::VideoFormat::BGRA,
            spa::param::video::VideoFormat::RGBA,
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle { width: 1920, height: 1080 },
            spa::utils::Rectangle { width: 2, height: 2 },
            spa::utils::Rectangle { width: 7680, height: 4320 }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: 30, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: 240, denom: 1 }
        ),
    );
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .expect("serializing a fixed format pod cannot fail")
    .0
    .into_inner()
}

/// The buffer metadata this capture needs, as a serialized SPA pod.
///
/// Asking for `SPA_META_Cursor` is what makes the compositor report the pointer
/// per frame; without it the metadata is simply absent, whatever cursor mode the
/// portal agreed to. The size is a budget PipeWire allocates on every buffer, so
/// it covers the two structs plus the largest bitmap that will be accepted and
/// nothing more.
///
/// Built from `Property` directly rather than the `property!` macro, which
/// requires a key type with `as_raw()`; the `SPA_PARAM_META_*` keys are plain
/// constants.
fn cursor_meta_params() -> Vec<u8> {
    let size = std::mem::size_of::<spa::sys::spa_meta_cursor>()
        + std::mem::size_of::<spa::sys::spa_meta_bitmap>()
        + (MAX_CURSOR_EDGE as usize) * (MAX_CURSOR_EDGE as usize) * 4;
    let obj = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamMeta.as_raw(),
        id: spa::param::ParamType::Meta.as_raw(),
        properties: vec![
            spa::pod::Property::new(
                spa::sys::SPA_PARAM_META_type,
                spa::pod::Value::Id(spa::utils::Id(spa::sys::SPA_META_Cursor)),
            ),
            spa::pod::Property::new(
                spa::sys::SPA_PARAM_META_size,
                spa::pod::Value::Int(size as i32),
            ),
        ],
    };
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .expect("serializing a fixed metadata pod cannot fail")
    .0
    .into_inner()
}

/// Paces captured frames into ffmpeg and returns how many were written.
///
/// The source rate is variable — the compositor sends a frame when the screen
/// changes — so frames are emitted on a fixed clock instead, repeating the last
/// picture when nothing moved. That is what makes the file's duration equal the
/// time that actually passed; writing frames as they arrive would make a still
/// screen produce a short video and a busy one a long video.
fn write_frames(
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    fps: u32,
    mic: bool,
    output: PathBuf,
    ffmpeg: PathBuf,
) -> Result<u64, String> {
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(fps));

    // Wait for the first frame: its format is what ffmpeg has to be configured
    // with, and guessing would mean re-encoding or a wrong picture.
    let (width, height, pix_fmt) = {
        let mut slot = shared
            .slot
            .lock()
            .map_err(|_| "the frame slot was poisoned".to_string())?;
        loop {
            if let Some(slot) = slot.as_ref() {
                if slot.delivered > 0 {
                    break (slot.width, slot.height, slot.pix_fmt);
                }
            }
            if stop.load(Ordering::Acquire) {
                // Stopped before any frame arrived. Not an error here: the
                // caller already reports a capture that produced no picture.
                return Ok(0);
            }
            let (next, _) = shared
                .arrived
                .wait_timeout(slot, frame_interval)
                .map_err(|_| "the frame slot was poisoned".to_string())?;
            slot = next;
        }
    };

    let mut child = spawn_encoder(&ffmpeg, pix_fmt, width, height, fps, mic, &output)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ffmpeg did not accept a stdin pipe".to_string())?;

    let row = shared
        .slot
        .lock()
        .map_err(|_| "the frame slot was poisoned".to_string())?
        .as_ref()
        .map(|slot| slot.pixels.len())
        .unwrap_or(0);
    let mut frame = vec![0u8; row];
    let mut written = 0u64;
    let started = Instant::now();
    let mut write_error = None;

    // Publish time zero of the file. The cursor track is timestamped against
    // this and not against the portal session, which starts earlier — by the
    // picker dialog, the negotiation and ffmpeg's own startup.
    if let Ok(mut origin) = shared.origin.lock() {
        *origin = Some(started);
    }

    while !stop.load(Ordering::Acquire) {
        // Deadlines from a fixed origin rather than sleeping a fixed interval,
        // so the time spent encoding does not accumulate into drift. This is
        // the same mistake that once made the recording clock run slow.
        let deadline = started + frame_interval * (written as u32 + 1);
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }

        {
            let slot = shared
                .slot
                .lock()
                .map_err(|_| "the frame slot was poisoned".to_string())?;
            let Some(slot) = slot.as_ref() else { continue };
            frame.copy_from_slice(&slot.pixels);
        }

        if let Err(error) = stdin.write_all(&frame) {
            write_error = Some(format!("ffmpeg stopped accepting frames: {error}"));
            break;
        }
        written += 1;
    }

    // Closing stdin is what makes ffmpeg flush and finalise the container.
    // Skipping it leaves a truncated file that reads as a broken recording.
    drop(stdin);
    let status = child
        .wait()
        .map_err(|e| format!("could not wait for ffmpeg: {e}"))?;

    if let Some(error) = write_error {
        return Err(error);
    }
    if !status.success() {
        return Err(format!(
            "ffmpeg exited with {status} while encoding the recording."
        ));
    }
    Ok(written)
}

fn spawn_encoder(
    ffmpeg: &Path,
    pix_fmt: &str,
    width: usize,
    height: usize,
    fps: u32,
    mic: bool,
    output: &Path,
) -> Result<std::process::Child, String> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create the recordings directory: {e}"))?;
    }

    let mut command = std::process::Command::new(ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error", "-y"]);
    command.args([
        "-f",
        "rawvideo",
        "-pix_fmt",
        pix_fmt,
        "-s",
        &format!("{width}x{height}"),
        "-r",
        &fps.to_string(),
        "-i",
        "-",
    ]);
    if mic {
        // PipeWire exposes a PulseAudio-compatible server, so this is the one
        // input that works on both a PipeWire and a PulseAudio machine.
        command.args(["-f", "pulse", "-i", "default"]);
    }
    command.args([
        "-c:v",
        "libvpx-vp9",
        // Capture is live: the encoder has to keep up with the clock, not
        // produce the smallest file. A slow encoder here would back up the
        // pipe and stall the writer, which paces every frame after it.
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-b:v",
        "0",
        "-crf",
        "32",
        "-pix_fmt",
        "yuv420p",
    ]);
    if mic {
        command.args(["-c:a", "libopus", "-b:a", "128k"]);
    }
    command.arg(output);

    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start ffmpeg for the recording: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 4-byte-per-pixel frame in `BGRx`, filled with one colour.
    fn frame(width: usize, height: usize, bgr: [u8; 3]) -> Vec<u8> {
        let mut pixels = vec![0u8; width * height * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[0] = bgr[0];
            pixel[1] = bgr[1];
            pixel[2] = bgr[2];
        }
        pixels
    }

    /// A cursor of one colour at one alpha, premultiplied as the compositor
    /// would hand it over.
    fn cursor(width: usize, height: usize, rgb: [u8; 3], alpha: u8) -> CursorBitmap {
        let mut pixels = vec![0u8; width * height * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[0] = (u32::from(rgb[0]) * u32::from(alpha) / 255) as u8;
            pixel[1] = (u32::from(rgb[1]) * u32::from(alpha) / 255) as u8;
            pixel[2] = (u32::from(rgb[2]) * u32::from(alpha) / 255) as u8;
            pixel[3] = alpha;
        }
        CursorBitmap {
            width,
            height,
            hotspot_x: 0,
            hotspot_y: 0,
            pixels,
        }
    }

    fn bgrx(width: usize, height: usize, pixels: &mut [u8]) -> FrameView<'_> {
        FrameView {
            pixels,
            width,
            height,
            bpp: 4,
            channels: channels(spa::param::video::VideoFormat::BGRx).unwrap(),
        }
    }

    #[test]
    fn channel_offsets_follow_memory_order() {
        use spa::param::video::VideoFormat as F;
        assert_eq!(
            channels(F::BGRx),
            Some(Channels { r: 2, g: 1, b: 0, a: None })
        );
        assert_eq!(
            channels(F::RGBA),
            Some(Channels { r: 0, g: 1, b: 2, a: Some(3) })
        );
        // Planar formats are never negotiated, and guessing an offset for one
        // would write the cursor into the wrong plane.
        assert_eq!(channels(F::I420), None);
    }

    #[test]
    fn an_opaque_cursor_replaces_the_pixels_under_it() {
        let mut pixels = frame(2, 2, [0, 0, 0]);
        // Red cursor onto a black BGRx frame: red is byte 2.
        blend_cursor(&mut bgrx(2, 2, &mut pixels), &cursor(2, 2, [255, 0, 0], 255), 0, 0);
        assert_eq!(&pixels[0..3], &[0, 0, 255]);
        assert_eq!(&pixels[12..15], &[0, 0, 255]);
    }

    #[test]
    fn a_transparent_cursor_leaves_the_frame_alone() {
        let mut pixels = frame(2, 2, [10, 20, 30]);
        let before = pixels.clone();
        blend_cursor(&mut bgrx(2, 2, &mut pixels), &cursor(2, 2, [255, 255, 255], 0), 0, 0);
        assert_eq!(pixels, before);
    }

    #[test]
    fn a_half_transparent_cursor_blends_premultiplied() {
        let mut pixels = frame(1, 1, [0, 0, 200]);
        blend_cursor(&mut bgrx(1, 1, &mut pixels), &cursor(1, 1, [0, 0, 0], 128), 0, 0);
        // Premultiplied black at a=128 darkens: 0 + 200 * 127/255 ≈ 100. Read as
        // straight alpha it would instead stay near 200 and look untouched.
        assert_eq!(pixels[2], 100);
    }

    #[test]
    fn the_hotspot_decides_where_the_bitmap_lands() {
        let mut pixels = frame(3, 1, [0, 0, 0]);
        let mut pointer = cursor(1, 1, [255, 255, 255], 255);
        pointer.hotspot_x = 2;
        // The pointer is at x=2, but points two pixels into its own bitmap, so
        // the bitmap starts at x=0.
        blend_cursor(&mut bgrx(3, 1, &mut pixels), &pointer, 2, 0);
        assert_eq!(pixels[0], 255);
        assert_eq!(pixels[4], 0);
    }

    #[test]
    fn a_cursor_off_the_edge_is_drawn_in_part() {
        let mut pixels = frame(2, 2, [0, 0, 0]);
        // Top-left at (1, 1): only one of the four cursor pixels is on screen.
        blend_cursor(&mut bgrx(2, 2, &mut pixels), &cursor(2, 2, [255, 255, 255], 255), 1, 1);
        assert_eq!(pixels[0], 0);
        assert_eq!(pixels[12], 255);
    }

    #[test]
    fn a_cursor_fully_outside_the_frame_touches_nothing() {
        let mut pixels = frame(2, 2, [7, 7, 7]);
        let before = pixels.clone();
        let pointer = cursor(2, 2, [255, 255, 255], 255);
        blend_cursor(&mut bgrx(2, 2, &mut pixels), &pointer, -9, -9);
        blend_cursor(&mut bgrx(2, 2, &mut pixels), &pointer, 9, 9);
        assert_eq!(pixels, before);
    }

    #[test]
    fn a_track_without_an_origin_is_empty() {
        // The encoder never started, so there is no timeline to place the
        // samples on. Reporting them against the portal session instead would
        // offset the whole track by however long the picker was open.
        let moments = vec![CursorMoment {
            at: Instant::now(),
            x: 0.5,
            y: 0.5,
        }];
        assert!(cursor_track(None, &moments).is_empty());
    }

    #[test]
    fn a_track_is_timestamped_from_the_encoder_origin() {
        let origin = Instant::now();
        let moments = vec![
            CursorMoment {
                at: origin,
                x: 0.1,
                y: 0.1,
            },
            CursorMoment {
                at: origin + Duration::from_millis(500),
                x: 0.9,
                y: 0.9,
            },
        ];
        let track = cursor_track(Some(origin), &moments);
        assert_eq!(track.len(), 2);
        assert_eq!(track[0].t, 0);
        assert_eq!(track[1].t, 500);
        assert_eq!(track[1].x, 0.9);
    }

    #[test]
    fn moments_from_before_the_encoder_are_pinned_to_zero() {
        let origin = Instant::now();
        let early = origin
            .checked_sub(Duration::from_millis(300))
            .expect("the test clock is not near the epoch");
        let moments = vec![CursorMoment {
            at: early,
            x: 0.25,
            y: 0.75,
        }];
        let track = cursor_track(Some(origin), &moments);
        // Kept rather than dropped: it is where the cursor was when recording
        // began, which is exactly what a zoom needs to start from.
        assert_eq!(track.len(), 1);
        assert_eq!(track[0].t, 0);
    }

    #[test]
    fn a_still_cursor_is_thinned_to_a_heartbeat() {
        let origin = Instant::now();
        let moments: Vec<CursorMoment> = (0..10)
            .map(|i| CursorMoment {
                at: origin + Duration::from_millis(i * 40),
                x: 0.5,
                y: 0.5,
            })
            .collect();
        let track = cursor_track(Some(origin), &moments);
        // 400 ms of a motionless cursor: the first sample plus one heartbeat.
        assert_eq!(track.len(), 2);
        assert_eq!(track[0].t, 0);
        assert_eq!(track[1].t, 280);
    }

    #[test]
    fn the_cursor_metadata_pod_asks_for_a_cursor() {
        let bytes = cursor_meta_params();
        assert!(spa::pod::Pod::from_bytes(&bytes).is_some());

        let (_, value) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&bytes)
            .expect("the pod this module builds must parse back");
        let spa::pod::Value::Object(object) = value else {
            panic!("expected an object pod");
        };
        assert_eq!(object.id, spa::param::ParamType::Meta.as_raw());
        let types: Vec<_> = object
            .properties
            .iter()
            .filter(|p| p.key == spa::sys::SPA_PARAM_META_type)
            .map(|p| p.value.clone())
            .collect();
        assert_eq!(
            types,
            vec![spa::pod::Value::Id(spa::utils::Id(spa::sys::SPA_META_Cursor))]
        );

        // The size is the budget PipeWire allocates per buffer: both structs
        // plus the largest bitmap that will be accepted.
        let expected = (std::mem::size_of::<spa::sys::spa_meta_cursor>()
            + std::mem::size_of::<spa::sys::spa_meta_bitmap>()
            + (MAX_CURSOR_EDGE as usize).pow(2) * 4) as i32;
        assert!(object.properties.iter().any(|p| {
            p.key == spa::sys::SPA_PARAM_META_size && p.value == spa::pod::Value::Int(expected)
        }));
    }
}
