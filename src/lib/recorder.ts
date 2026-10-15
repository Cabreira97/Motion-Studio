/**
 * Webview screen recording: `getDisplayMedia` for the picture (the OS shows
 * its own screen/window picker) plus an optional microphone track, combined
 * into a single `MediaRecorder` recording. Region capture is a non-destructive
 * crop applied later in the ffmpeg render step.
 */

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
): MediaTrackConstraints | true {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const video: MediaTrackConstraints & { displaySurface?: string } = {};

  // `ideal` only. The Screen Capture spec rejects a display request outright if
  // a constraint carries `min` or `exact`, and engines vary in how strictly they
  // read the rest, so asking for a ceiling we do not need is a risk with no
  // payoff — the requested rate is already the ideal.
  if (supported.frameRate) video.frameRate = { ideal: fps };
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
 * Window scanned for the first cluster. The recorder is started with a 1s
 * timeslice, so a working capture emits a cluster a few hundred bytes after the
 * header — reading the whole blob (hundreds of MB) to learn the same thing
 * would be pointless.
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
    const settings = videoTrack.getSettings();
    this.resultWidth = settings.width ?? 1920;
    this.resultHeight = settings.height ?? 1080;

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
    this.recorder.start(1000);
    this.startedAt = performance.now();
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
    // Diagnose before cleanup, while the track state is still readable.
    const empty = blob.size === 0 || !(await hasMediaClusters(blob));
    const diagnosis = empty ? this.diagnoseEmpty(mimeType) : "";
    this.recorder = null;
    this.chunks = [];
    this.videoTrack = null;
    this.cleanup();
    if (empty) throw new Error(diagnosis);
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

    const size =
      this.resultWidth > 0 && this.resultHeight > 0
        ? `${this.resultWidth}×${this.resultHeight}`
        : "unknown size";
    return `The recording holds no frames — the encoder wrote a header and nothing else. Source: ${size}, track ${track?.readyState ?? "missing"}, format ${mimeType}, ${Math.round(this.elapsedMs)}ms.`;
  }

  /** Aborts without producing a result. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    this.chunks = [];
    this.cleanup();
  }
}
