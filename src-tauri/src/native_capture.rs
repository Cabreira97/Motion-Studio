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
use crate::capture::NativeRecording;

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

    let (node_id, fd) = match runtime.block_on(open_portal(kind)) {
        Ok(pair) => pair,
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

    let pipewire_result = run_pipewire(node_id, fd, Arc::clone(&shared), quit_rx, &ready_tx);

    stop_writer.store(true, Ordering::Release);
    let written = match writer.join() {
        Ok(result) => result,
        Err(_) => Err("the encoder thread panicked".to_string()),
    };

    pipewire_result?;
    let written = written?;

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

async fn open_portal(
    kind: CaptureKind,
) -> ashpd::Result<(u32, std::os::fd::OwnedFd)> {
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

    let session = proxy.create_session(Default::default()).await?;
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                // Let the compositor composite the pointer into the picture. On
                // Wayland an application cannot read the pointer position at
                // all, which is why cursor-following zoom degrades to manual
                // there; a cursor baked into the frame at least keeps the
                // recording watchable.
                .set_cursor_mode(CursorMode::Embedded)
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
    Ok((stream.pipe_wire_node_id(), fd))
}

fn run_pipewire(
    node_id: u32,
    fd: std::os::fd::OwnedFd,
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

    let mut params = format_params();
    let mut pods = [spa::pod::Pod::from_bytes(&params).ok_or("malformed format pod")?];
    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut pods,
        )
        .map_err(|e| format!("could not connect to the capture stream: {e}"))?;
    params.clear();

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
