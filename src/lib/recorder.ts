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

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm",
];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "video/webm";
}

function isOverconstrained(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "OverconstrainedError" || error.name === "TypeError")
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
  kind: CaptureKind,
  fps: number,
): MediaTrackConstraints | true {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const video: MediaTrackConstraints & { displaySurface?: string } = {};

  if (supported.frameRate) video.frameRate = { ideal: fps, max: 60 };
  // Hint the OS picker so "window" surfaces windows first; "screen"/"region"
  // surface full monitors (region is a non-destructive crop applied on export).
  if ("displaySurface" in supported) {
    video.displaySurface = kind === "window" ? "window" : "monitor";
  }

  return Object.keys(video).length > 0 ? video : true;
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
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video,
        audio: false,
      });
    } catch (error) {
      // Last resort: an engine can advertise a constraint and still reject the
      // value. Retry bare rather than losing a capture the user already
      // approved in the OS picker.
      if (video === true || !isOverconstrained(error)) throw error;
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
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
    const mimeType = pickMimeType();
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

    const mimeType = recorder.mimeType || pickMimeType();
    const blob = new Blob(this.chunks, { type: mimeType });
    const result: RecordingResult = {
      blob,
      mimeType,
      hasAudio: this.hasAudio,
      width: this.resultWidth,
      height: this.resultHeight,
    };
    const diagnosis = this.diagnoseEmpty(mimeType);
    this.recorder = null;
    this.chunks = [];
    this.videoTrack = null;
    this.cleanup();
    if (blob.size === 0) throw new Error(diagnosis);
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

    const size =
      this.resultWidth > 0 && this.resultHeight > 0
        ? `${this.resultWidth}×${this.resultHeight}`
        : "unknown size";
    return `The recording is empty — nothing was captured. Source: ${size}, track ${track?.readyState ?? "missing"}, format ${mimeType}.`;
  }

  /** Aborts without producing a result. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    this.chunks = [];
    this.cleanup();
  }
}
