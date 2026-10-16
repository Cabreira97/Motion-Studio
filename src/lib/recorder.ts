/**
 * Webview screen recording: `getDisplayMedia` for the picture (the OS shows
 * its own screen/window picker) plus an optional microphone track, combined
 * into a single `MediaRecorder` recording. Region capture is a non-destructive
 * crop applied later in the ffmpeg render step.
 */

import { FrameBridge } from "./frame-bridge.js";

export type CaptureKind = "screen" | "window" | "region";

export interface StartOptions {
  kind: CaptureKind;
  mic: boolean;
  fps?: number;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  hasAudio: boolean;
  width: number;
  height: number;
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
 * The resolution to ask a display source for: the screen in device pixels.
 *
 * Rounded down to even numbers because I420 — what every WebM encoder here
 * consumes — stores chroma at half resolution in both axes, so an odd side has
 * no valid chroma plane and the encoder refuses to configure.
 */
export function preferredCaptureSize(): CaptureSize {
  const screen = typeof globalThis.screen === "object" ? globalThis.screen : null;
  const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const width = Math.round((screen?.width ?? 1920) * ratio);
  const height = Math.round((screen?.height ?? 1080) * ratio);
  return { width: width - (width % 2), height: height - (height % 2) };
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
  kind: CaptureKind,
  fps: number,
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
  // Hint the OS picker so "window" surfaces windows first; "screen"/"region"
  // surface full monitors (region is a non-destructive crop applied on export).
  if ("displaySurface" in supported) {
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
 * Explains a well-formed recording that holds no picture, or `null` if it does.
 *
 * `canvas.captureStream(fps)` emits frames at its fixed rate whether or not
 * anything was ever drawn onto the canvas, so a capture source that delivers
 * nothing still produces a complete, playable file — of a blank canvas. Byte
 * size and cluster presence both read as success there. The count of frames
 * drawn from the source is the only reading that does not, so it decides.
 */
export interface BlankCheck {
  drawnFrames: number;
  elapsedMs: number;
  /** Frames whose pixels were read back; `0` means readback never succeeded. */
  sampledFrames: number;
  /** Of those, how many held any picture. */
  litFrames: number;
  scheduler: string;
}

export function describeBlankRecording(check: BlankCheck): string | null {
  const { drawnFrames, elapsedMs, sampledFrames, litFrames, scheduler } = check;
  // Name the scheduler: both of them having drawn nothing rules out the draw
  // loop itself, which is the next thing anyone reading this would suspect.
  const how = scheduler ? ` (draw scheduler: ${scheduler})` : "";
  if (drawnFrames === 0) {
    return `The capture source produced no picture in ${Math.round(elapsedMs)}ms${how} — the share was approved and the track reported itself live, but not one frame arrived. Saving this would have produced a blank video.`;
  }
  // Frames arrived and every one of them was black. On Linux this is
  // WebKitGTK's GL video sink handing out GPU-side frames that read back as
  // black; `WEBKIT_GST_DISABLE_GL_SINK=1` is what turns that off, and the app
  // sets it at startup — so reaching here means it did not take effect.
  if (sampledFrames > 0 && litFrames === 0) {
    return `All ${drawnFrames} captured frames were black (${sampledFrames} checked, none with any picture). The capture and the encoder both worked; the frames themselves carried no image. On Linux this is the webview's GL video sink — try starting the app with WEBKIT_GST_DISABLE_GL_SINK=1.`;
  }
  return null;
}

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

export class ScreenRecorder {
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
  private bridge: FrameBridge | null = null;
  private drawnFrames = 0;
  private scheduler = "";
  private litFrames = 0;
  private sampledFrames = 0;

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
    const video = buildDisplayConstraints(options.kind, fps);
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

    // Record a canvas copy of the capture, not the capture track itself. See
    // frame-bridge.ts: WebKitGTK's display track delivers no frame to its own
    // encoder, while the same encoder records a canvas stream correctly.
    const size = preferredCaptureSize();
    try {
      // Awaiting here is safe: the user gesture was already spent by
      // `getDisplayMedia` above and nothing after this point needs one.
      this.bridge = await FrameBridge.open(new MediaStream([videoTrack]), {
        fps,
        width: this.resultWidth || size.width,
        height: this.resultHeight || size.height,
      });
      tracks[0] = this.bridge.videoTrack;
    } catch (error) {
      // The share is already approved at this point, so failing without
      // releasing it would leave the OS screen-sharing indicator on with no
      // recording behind it and no way to start a new one.
      this.cleanup();
      throw error;
    }

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

  private blankCheck(): BlankCheck {
    return {
      drawnFrames: this.drawnFrames,
      elapsedMs: this.elapsedMs,
      sampledFrames: this.sampledFrames,
      litFrames: this.litFrames,
      scheduler: this.scheduler,
    };
  }

  private cleanup(): void {
    this.bridge?.stop();
    this.bridge = null;
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
    // frames, so this is the first point the reported size can be trusted. The
    // canvas is the authority, since that is what was encoded.
    if (this.videoTrack) this.readDimensions(this.videoTrack);
    if (this.bridge) {
      this.resultWidth = this.bridge.width;
      this.resultHeight = this.bridge.height;
      this.drawnFrames = this.bridge.drawnFrames;
      this.scheduler = this.bridge.schedulerName;
      this.litFrames = this.bridge.litFrames;
      this.sampledFrames = this.bridge.sampledFrames;
    }
    if (recorder.state !== "inactive") recorder.stop();
    await finished;

    const mimeType = recorder.mimeType || pickMimeType(this.hasAudio);
    const blob = new Blob(this.chunks, { type: mimeType });
    const result: RecordingResult = {
      blob,
      mimeType,
      hasAudio: this.hasAudio,
      width: this.resultWidth,
      height: this.resultHeight,
    };
    // Diagnose before cleanup, while the track state is still readable and
    // `elapsedMs` still has a start time to measure from.
    const empty = blob.size === 0 || !(await hasMediaClusters(blob));
    const diagnosis = empty
      ? this.diagnoseEmpty(mimeType)
      : describeBlankRecording(this.blankCheck());
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
    // The frame counter is the one unambiguous reading available: it counts
    // pictures that actually arrived from the capture source, so zero rules the
    // encoder out entirely and anything above zero rules the source out.
    const blank = describeBlankRecording(this.blankCheck());
    if (blank) return blank;
    return `${this.drawnFrames} frames were captured but none were encoded (format ${mimeType}, ${this.resultWidth}×${this.resultHeight}). The capture worked and the encoder dropped it.`;
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
