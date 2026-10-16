/**
 * Re-publishes a capture stream as a canvas stream before it reaches the
 * encoder.
 *
 * WebKitGTK hands out a display track that looks healthy — `live`, unmuted,
 * with a sane reported size — and then delivers no frame to its own encoder:
 * the muxer writes a header and never fills `Tracks`. The same `MediaRecorder`,
 * the same vp9 encoder and the same muxer produce a correct file from a canvas
 * stream in that engine, verified directly against it. So the frames are drawn
 * to a canvas first and the canvas is what gets recorded.
 *
 * The copy costs CPU on engines where the direct path works, which buys one
 * code path instead of sniffing engines, and a frame counter that can state
 * plainly whether the capture source produced a picture at all — rather than
 * writing a black video and calling it a success.
 */

export interface FrameBridgeOptions {
  fps: number;
  /** Fallback size, used until the source reports its own. */
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
export function evenSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(2, Math.floor(width));
  const h = Math.max(2, Math.floor(height));
  return { width: w - (w % 2), height: h - (h % 2) };
}

/** How long to wait for a per-frame callback before polling instead. */
const SCHEDULER_WATCHDOG_MS = 1000;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class FrameBridge {
  private video: VideoWithFrameCallback;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream;
  private frameHandle: number | null = null;
  private intervalHandle: number | null = null;
  private watchdogHandle: number | null = null;
  private frames = 0;
  private stopped = false;
  private scheduler: "requestVideoFrameCallback" | "interval" = "interval";

  /**
   * Starts drawing and returns a bridge whose canvas size is already settled.
   *
   * Asynchronous on purpose: the canvas has to be sized from the source before
   * `captureStream` is called, because resizing a canvas that is already being
   * captured changes the track's resolution mid-stream — its own way of
   * producing a file the encoder cannot make sense of. A source that never
   * reports a size still resolves, on the fallback size, so the frame counter
   * gets the chance to say nothing arrived.
   */
  static async open(
    source: MediaStream,
    options: FrameBridgeOptions,
    timeoutMs = 2000,
  ): Promise<FrameBridge> {
    const bridge = new FrameBridge(source, options);
    await bridge.waitForSourceSize(timeoutMs);
    bridge.begin(options.fps);
    return bridge;
  }

  /** Frames actually drawn from the capture source. */
  get drawnFrames(): number {
    return this.frames;
  }

  /** Which draw scheduler ended up driving the copy, named in failure reports. */
  get schedulerName(): string {
    return this.scheduler;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** The video track to record in place of the capture source's own. */
  get videoTrack(): MediaStreamTrack {
    const track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error("The canvas produced no video track to record.");
    return track;
  }

  private constructor(source: MediaStream, options: FrameBridgeOptions) {
    const size = evenSize(options.width, options.height);
    this.canvas = document.createElement("canvas");
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create a 2D canvas context to record into.");
    this.ctx = ctx;
    this.stream = new MediaStream();

    this.video = document.createElement("video") as VideoWithFrameCallback;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.srcObject = source;
    // Kept in the document but off-screen: a detached or `display: none` video
    // is allowed to stop producing frames, which is the one thing needed here.
    this.video.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(this.video);

    void this.video.play().catch(() => {
      // Autoplay of a muted stream should not be blocked, and a rejection here
      // is not fatal on its own — the frame counter reports the outcome.
    });
  }

  private async waitForSourceSize(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.video.videoWidth && !this.stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { videoWidth, videoHeight } = this.video;
    if (!videoWidth || !videoHeight) return;
    const size = evenSize(videoWidth, videoHeight);
    this.canvas.width = size.width;
    this.canvas.height = size.height;
  }

  private begin(fps: number): void {
    this.stream = this.canvas.captureStream(fps);
    this.schedule(fps);
  }

  private draw(): void {
    if (this.stopped) return;
    if (!this.video.videoWidth || !this.video.videoHeight) return;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    this.frames += 1;
  }

  private schedule(fps: number): void {
    const request = this.video.requestVideoFrameCallback;
    if (typeof request === "function") {
      this.scheduler = "requestVideoFrameCallback";
      const pump = () => {
        if (this.stopped) return;
        this.draw();
        this.frameHandle = request.call(this.video, pump);
      };
      this.frameHandle = request.call(this.video, pump);
      // Per-frame callbacks are the better scheduler — one draw per delivered
      // frame, no duplicates — but they are only known to fire for a
      // canvas-backed stream in WebKitGTK, not a display-backed one. If none
      // has fired by the deadline, fall back rather than let an unfired
      // callback masquerade as a capture source with no picture.
      this.watchdogHandle = window.setTimeout(() => {
        if (this.stopped || this.frames > 0) return;
        if (this.frameHandle !== null) this.video.cancelVideoFrameCallback?.(this.frameHandle);
        this.frameHandle = null;
        this.poll(fps);
      }, SCHEDULER_WATCHDOG_MS);
      return;
    }
    this.poll(fps);
  }

  /**
   * Draws at a fixed rate, for engines without per-frame callbacks.
   *
   * A repaint-driven loop is not usable here: the window is normally not
   * visible while recording, and background throttling would starve it.
   */
  private poll(fps: number): void {
    this.scheduler = "interval";
    this.intervalHandle = window.setInterval(() => this.draw(), Math.max(1, Math.round(1000 / fps)));
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
    if (this.watchdogHandle !== null) window.clearTimeout(this.watchdogHandle);
    if (this.frameHandle !== null) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    this.intervalHandle = null;
    this.watchdogHandle = null;
    this.frameHandle = null;
    this.stream.getTracks().forEach((track) => track.stop());
    this.video.srcObject = null;
    this.video.remove();
  }
}
