/**
 * Screen recording, in the two shapes this app supports.
 *
 * [`ScreenRecorder`] is the webview one: `getDisplayMedia` for the picture (the
 * OS shows its own screen/window picker) plus an optional microphone track,
 * combined into a single `MediaRecorder`. It hands back a blob to save.
 *
 * [`NativeRecorder`] drives the Rust backend instead, and is what Linux uses.
 * The webview cannot capture there at all: WebKitGTK's display track encodes to
 * zero frames, and its frames read back black through both a 2D canvas and
 * WebGL — measured, with the saved file reporting limited-range black on every
 * frame. Rust records through xdg-desktop-portal and writes the file itself, so
 * that recorder returns a path and no blob.
 *
 * Which one runs is decided by `captureCapabilities().videoBackend`, because
 * the platform is the Rust side's to report, not something to sniff from a user
 * agent string.
 *
 * Region capture is a non-destructive crop applied later in the ffmpeg render
 * step, in both backends.
 */

import { bridge } from "./bridge.js";

export type CaptureKind = "screen" | "window" | "region";

export interface StartOptions {
  kind: CaptureKind;
  mic: boolean;
  fps?: number;
  /** Used to name the file when the backend is the one writing it. */
  name?: string;
}

export interface RecordingResult {
  /** The encoded bytes, when the webview recorded. `null` for a native one. */
  blob: Blob | null;
  /** Where the file already is, when the backend wrote it. `null` otherwise. */
  path: string | null;
  mimeType: string;
  hasAudio: boolean;
  width: number;
  height: number;
}

/** What `App` drives, whichever backend is behind it. */
export interface Recorder {
  readonly elapsedMs: number;
  start(options: StartOptions): Promise<void>;
  stop(): Promise<RecordingResult>;
  cancel(): void;
}

const AV_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const VIDEO_ONLY_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

/**
 * Picks a container that describes the tracks actually being recorded.
 *
 * Asking for `opus` on a video-only stream is not harmless: GStreamer (so
 * WebKitGTK) muxes a stream it was told has audio and waits for buffers that
 * never arrive, so `ondataavailable` never fires and the recording comes out
 * empty at stop time. Chrome tolerates the mismatch, which is why this only
 * shows up on Linux.
 */
export function pickMimeType(hasAudio: boolean): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  const candidates = hasAudio ? AV_MIME_CANDIDATES : VIDEO_ONLY_MIME_CANDIDATES;
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "video/webm";
}

export interface CaptureSize {
  width: number;
  height: number;
}

/**
 * Rounds a frame size down to even sides.
 *
 * I420 stores chroma at half resolution in both axes, so an odd side has no
 * valid chroma plane and the encoder refuses to configure — an observed 112x63
 * display track was enough to produce a recording with no frames in it.
 */
export function evenSize(width: number, height: number): CaptureSize {
  const w = Math.max(2, Math.floor(width));
  const h = Math.max(2, Math.floor(height));
  return { width: w - (w % 2), height: h - (h % 2) };
}

/** The resolution to ask a display source for: the screen in device pixels. */
export function preferredCaptureSize(): CaptureSize {
  const screen = typeof globalThis.screen === "object" ? globalThis.screen : null;
  const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return evenSize(
    Math.round((screen?.width ?? 1920) * ratio),
    Math.round((screen?.height ?? 1080) * ratio),
  );
}

/**
 * Builds display constraints out of only what this engine actually implements.
 *
 * Sending a constraint an engine does not know rejects the whole call with
 * `OverconstrainedError` ("Invalid constraint") — WebKitGTK does that for
 * `displaySurface`, which kills recording on Linux after the user has already
 * picked a surface in the portal. `getSupportedConstraints` is synchronous, so
 * filtering here costs no user gesture.
 */
export function buildDisplayConstraints(
  fps: number,
  kind: CaptureKind = "screen",
  size: CaptureSize = preferredCaptureSize(),
): MediaTrackConstraints | true {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const video: MediaTrackConstraints & { displaySurface?: string } = {};

  // `ideal` only. The Screen Capture spec rejects a display request outright if
  // a constraint carries `min` or `exact`, and engines vary in how strictly they
  // read the rest, so asking for a ceiling we do not need is a risk with no
  // payoff — the requested rate is already the ideal.
  if (supported.frameRate) video.frameRate = { ideal: fps };
  // Ask for a real resolution. Left unasked, WebKitGTK negotiates its smallest
  // preset — an observed 112x63, correct in aspect and useless in size. The odd
  // height is the fatal part: the encoder cannot build an I420 chroma plane for
  // it, so it never configures and the recording ends up as a bare header.
  if (supported.width) video.width = { ideal: size.width };
  if (supported.height) video.height = { ideal: size.height };
  // Hint the OS picker so "window" surfaces windows first. "region" asks for a
  // monitor, since the region is a crop applied on export rather than a
  // different kind of capture.
  //
  // This is sent only where it can be trusted. WebKitGTK lists `displaySurface`
  // as supported and then rejects the call anyway — `monitor` is accepted but
  // `window` fails with "Invalid constraint" after the user has already picked
  // a surface — which is why Linux does not use this recorder at all.
  if (supported.displaySurface) {
    video.displaySurface = kind === "window" ? "window" : "monitor";
  }

  return Object.keys(video).length > 0 ? video : true;
}

/**
 * Turns a `getDisplayMedia` rejection into something a user can act on.
 *
 * The raw errors are too vague to place blame: `NotAllowedError` covers both a
 * declined picker and an embedder that never answered WebKitGTK's permission
 * signal, and `OverconstrainedError` arrives as a bare "Invalid constraint"
 * that names neither the constraint nor the value. Repeat what was asked for,
 * since that is the part we control.
 */
export function describeCaptureFailure(
  error: unknown,
  video: MediaTrackConstraints | true,
): string {
  const name = error instanceof Error ? error.name : "Error";
  const detail = error instanceof Error ? error.message : String(error);
  const asked = video === true ? "no constraints" : JSON.stringify(video);

  switch (name) {
    case "NotAllowedError":
      return `Screen capture was refused (${detail}). Either the capture was declined in the system picker, or the webview denied it before the picker appeared.`;
    case "OverconstrainedError":
    case "TypeError":
      return `The capture source rejected the requested settings (${name}: ${detail}). Requested: ${asked}.`;
    case "NotFoundError":
      return `No capture source was available (${detail}). The screen picker found nothing to share.`;
    default:
      return `Screen capture failed (${name}: ${detail}). Requested: ${asked}.`;
  }
}

/** EBML id of a Matroska/WebM `Cluster`, the element every frame lives inside. */
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

/**
 * Window scanned for the first cluster. A working capture opens one a few
 * hundred bytes past the header, so reading the whole blob (hundreds of MB) to
 * learn the same thing would be pointless.
 */
const CLUSTER_SCAN_BYTES = 64 * 1024;

/**
 * Reports whether a recording contains any muxed frame.
 *
 * A stalled muxer still emits a valid-looking file: WebKitGTK produced a 178
 * byte blob holding two EBML headers and a `Tracks` element with no entries,
 * which is non-empty to `blob.size` and only fails later, in ffprobe, as
 * "End of file". Looking for a cluster distinguishes "no frames" from "small
 * recording" without guessing at a size threshold.
 */
export async function hasMediaClusters(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, CLUSTER_SCAN_BYTES).arrayBuffer());
  outer: for (let i = 0; i + CLUSTER_ID.length <= head.length; i += 1) {
    for (let j = 0; j < CLUSTER_ID.length; j += 1) {
      if (head[i + j] !== CLUSTER_ID[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function recorderSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export class ScreenRecorder implements Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private displayStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private startedAt = 0;
  private resultWidth = 0;
  private resultHeight = 0;
  private hasAudio = false;
  private recorderError: string | null = null;
  private videoTrack: MediaStreamTrack | null = null;

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : performance.now() - this.startedAt;
  }

  async start(options: StartOptions): Promise<void> {
    if (!recorderSupported()) {
      throw new Error(
        "Screen capture is not available in this environment. The desktop app (pnpm first-run) provides screen recording.",
      );
    }
    if (this.recorder) throw new Error("A recording is already in progress.");

    const fps = options.fps ?? 30;
    const video = buildDisplayConstraints(fps, options.kind);
    try {
      // Must stay in the same synchronous turn as the click: `getDisplayMedia`
      // spends the user gesture, so there is no retrying it. A second attempt
      // fails with "must be called from a user gesture handler" and that
      // message replaces the real reason the first attempt failed.
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video,
        audio: false,
      });
    } catch (error) {
      throw new Error(describeCaptureFailure(error, video));
    }

    const videoTrack = this.displayStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("No video track was returned by the capture source.");
    // Best effort only, and re-read at stop: a display track reports its real
    // size once frames are flowing, and before the first one WebKitGTK answers
    // with a placeholder (112×112 on a 4K monitor). Left at 0 when unknown
    // rather than guessing a resolution the export would then act on.
    this.readDimensions(videoTrack);

    const tracks: MediaStreamTrack[] = [videoTrack];

    if (options.mic) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        tracks.push(...this.micStream.getAudioTracks());
        this.hasAudio = this.micStream.getAudioTracks().length > 0;
      } catch (error) {
        // Microphone is optional: continue without it and surface a warning.
        console.warn("Microphone unavailable, recording without it:", error);
        this.micStream = null;
        this.hasAudio = false;
      }
    }

    // Stop automatically if the user ends sharing from the OS UI.
    videoTrack.addEventListener("ended", () => {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    });

    const stream = new MediaStream(tracks);
    const mimeType = pickMimeType(this.hasAudio);
    this.chunks = [];
    this.recorderError = null;
    this.videoTrack = videoTrack;
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    // An encoder that fails mid-recording reports it here and nowhere else;
    // without this the only symptom is an empty blob at stop time.
    this.recorder.onerror = (event) => {
      const cause = (event as Event & { error?: unknown }).error;
      this.recorderError = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      console.error("MediaRecorder failed:", cause);
    };
    // No timeslice. WebKitGTK restarts its muxer for every slice instead of
    // continuing the stream: a sliced recording came out as two back-to-back
    // EBML headers with an empty `Tracks` element and not one frame. Nothing
    // here consumes the intermediate chunks anyway — the blob is only read at
    // stop — so slicing was pure risk.
    this.recorder.start();
    this.startedAt = performance.now();
  }

  private readDimensions(track: MediaStreamTrack): void {
    const settings = track.getSettings();
    if (settings.width) this.resultWidth = settings.width;
    if (settings.height) this.resultHeight = settings.height;
  }

  private cleanup(): void {
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.displayStream = null;
    this.micStream = null;
    this.startedAt = 0;
  }

  async stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("No recording is in progress.");

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    // Read the size while the track is still running: by now it has delivered
    // frames, so this is the first point the reported size can be trusted.
    if (this.videoTrack) this.readDimensions(this.videoTrack);
    if (recorder.state !== "inactive") recorder.stop();
    await finished;

    const mimeType = recorder.mimeType || pickMimeType(this.hasAudio);
    const blob = new Blob(this.chunks, { type: mimeType });
    const result: RecordingResult = {
      blob,
      path: null,
      mimeType,
      hasAudio: this.hasAudio,
      width: this.resultWidth,
      height: this.resultHeight,
    };
    // Diagnose before cleanup, while the track state is still readable and
    // `elapsedMs` still has a start time to measure from.
    const empty = blob.size === 0 || !(await hasMediaClusters(blob));
    const diagnosis = empty ? this.diagnoseEmpty(mimeType) : null;
    this.recorder = null;
    this.chunks = [];
    this.videoTrack = null;
    this.cleanup();
    if (diagnosis) throw new Error(diagnosis);
    return result;
  }

  /**
   * Explains an empty recording with the facts that distinguish the causes.
   *
   * "Nothing was captured" alone is unactionable: an encoder that refused the
   * format, a capture source that ended immediately, and a source that never
   * produced a frame all look identical from the blob. Report what each one
   * leaves behind instead.
   */
  private diagnoseEmpty(mimeType: string): string {
    if (this.recorderError) {
      return `The recorder failed while encoding (${this.recorderError}). Format: ${mimeType}.`;
    }

    const track = this.videoTrack;
    if (track && track.readyState === "ended" && this.elapsedMs < 1500) {
      return "The capture source ended immediately — the screen share was stopped or denied before any frame arrived.";
    }
    // A muted track is the capture source's own statement that it delivered no
    // frame, which separates "nothing arrived" from "arrived but was not muxed".
    if (track?.muted) {
      return `The capture source delivered no frames (the track stayed muted) after ${Math.round(this.elapsedMs)}ms. The screen share was approved but never produced a picture.`;
    }
    return `The capture produced no encoded frames (format ${mimeType}, ${this.resultWidth}×${this.resultHeight}). The share was approved and the track stayed live, so the encoder is what dropped it.`;
  }

  /** Aborts without producing a result. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    this.chunks = [];
    this.videoTrack = null;
    this.cleanup();
  }
}

/**
 * Drives the Rust capture backend, used where the webview cannot record.
 *
 * Everything here is one `invoke` away, because the work genuinely happens in
 * Rust: the portal session, the PipeWire stream and ffmpeg all live there, and
 * the file is already on disk by the time `stop` resolves. That is why
 * `RecordingResult.blob` is `null` — there is nothing to save, and handing the
 * bytes back through the bridge just to write them out again would copy a
 * multi-hundred-megabyte recording through JSON for no reason.
 */
export class NativeRecorder implements Recorder {
  private startedAt = 0;
  private running = false;

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : performance.now() - this.startedAt;
  }

  async start(options: StartOptions): Promise<void> {
    if (this.running) throw new Error("A recording is already in progress.");
    const fps = options.fps ?? 30;
    const name = options.name ?? "Recording";
    // Resolves only once the picker has been answered and the first frame has
    // arrived, so the clock starts when there is really a picture to time.
    await bridge.nativeCaptureStart(options.kind, fps, options.mic, name);
    this.running = true;
    this.startedAt = performance.now();
  }

  async stop(): Promise<RecordingResult> {
    if (!this.running) throw new Error("No recording is in progress.");
    this.running = false;
    this.startedAt = 0;
    const recording = await bridge.nativeCaptureStop();
    return {
      blob: null,
      path: recording.path,
      // What the backend encodes. Kept as a declaration rather than read back
      // from the file, which `probeMedia` does anyway right after this.
      mimeType: "video/webm",
      hasAudio: recording.hasAudio,
      width: recording.width,
      height: recording.height,
    };
  }

  cancel(): void {
    if (!this.running) return;
    this.running = false;
    this.startedAt = 0;
    // Nothing waits on this: cancelling means the result is being thrown away,
    // and the backend still has to be told to release the screen share.
    void bridge.nativeCaptureStop().catch((error: unknown) => {
      console.warn("Could not stop the native capture cleanly:", error);
    });
  }
}

/**
 * Picks the recorder for this platform, as reported by the backend.
 *
 * Sniffing the user agent would be the wrong test twice over: the thing that
 * decides is which engine the webview embeds, and the Rust side is the only
 * part that knows whether a native backend was compiled in at all.
 */
export function createRecorder(videoBackend: string): Recorder {
  return videoBackend === "native" ? new NativeRecorder() : new ScreenRecorder();
}
