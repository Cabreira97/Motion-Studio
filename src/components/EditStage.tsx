import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { evaluateZoom } from "../core/cursor.js";
import { clampTextBox, computeStageLayout, zoomWindow } from "../core/filtergraph.js";
import { clamp, formatDuration } from "../core/time.js";
import type { Callout, Project, ZoomStop } from "../core/types.js";
import { useI18n } from "../lib/i18n.js";

/** `boxborderw` in `buildCalloutFilters`, in output pixels. */
const CALLOUT_BOX_BORDER_PX = 14;

/**
 * A human-readable reason for a `<video>` failure. The numeric code is kept
 * because it is what makes a report actionable: 4 means the source itself was
 * refused, 2 means it was reachable but the transfer broke.
 */
function describeMediaError(error: MediaError | null): string {
  if (!error) return "unknown";
  const names: Record<number, string> = {
    1: "aborted",
    2: "network",
    3: "decode",
    4: "source not supported",
  };
  const name = names[error.code] ?? "unknown";
  return error.message ? `${name} ${error.code}: ${error.message}` : `${name} ${error.code}`;
}

/**
 * The editor preview, rendered as the export would render it.
 *
 * Geometry comes from `computeStageLayout`, the zoom curve from
 * `evaluateZoom`, and the callout placement from `clampTextBox` — the same
 * three the ffmpeg graph is built from. Nothing here re-derives the layout, so
 * what the stage shows and what lands in the file cannot disagree without a
 * test failing.
 *
 * The transport is ours rather than the `<video>` element's: the video is
 * scaled and clipped by the zoom, which would carry the native controls off
 * the edge of the frame with it.
 */
export function EditStage({
  project,
  previewUrl,
  playheadMs,
  onPlayheadMs,
  focusStop,
  onFocus,
  onFocusDone,
  onMoveCallout,
}: {
  project: Project;
  previewUrl: string | null;
  /** Playhead in *source* time, matching `video.currentTime`. */
  playheadMs: number;
  onPlayheadMs: (ms: number) => void;
  /** The manual zoom whose focus point is being placed, if any. */
  focusStop: ZoomStop | null;
  onFocus: (cx: number, cy: number) => void;
  onFocusDone: () => void;
  onMoveCallout: (id: string, x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // A new source gets a clean slate; the element reports its own failure again.
  useEffect(() => setPreviewError(null), [previewUrl]);

  const { crop, framing, trim } = project;
  const clipMs = Math.max(0, trim.endMs - trim.startMs);
  const clipTimeMs = clamp(playheadMs - trim.startMs, 0, clipMs);
  const picking = focusStop !== null;

  const layout = useMemo(
    () =>
      computeStageLayout({
        sourceWidth: project.source?.width ?? framing.outputWidth,
        sourceHeight: project.source?.height ?? framing.outputHeight,
        crop,
        framing,
        presetId: project.export.presetId,
      }),
    [project.source?.width, project.source?.height, crop, framing, project.export.presetId],
  );
  const { out, content } = layout;

  // One number converts output pixels to screen pixels, which is what the
  // callout font size and the corner radius are specified in.
  const pxScale = stageWidth > 0 ? stageWidth / out.width : 0;

  // Placing a focus point against a zoomed frame would mean aiming at a moving
  // target, so picking shows the whole cropped frame instead.
  const zoom =
    project.zoom.enabled && !picking
      ? evaluateZoom(project.zoom.keyframes, clipTimeMs)
      : { scale: 1, cx: 0.5, cy: 0.5 };
  const window_ = zoomWindow(zoom.scale, zoom.cx, zoom.cy);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    setStageWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setStageWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // `timeupdate` fires about four times a second, which is too coarse for a
  // zoom curve — the preview would step rather than glide.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        const ms = Math.round(video.currentTime * 1000);
        // The preview plays the clip, not the file: stop where the export ends.
        if (ms >= trim.endMs) {
          video.pause();
          onPlayheadMs(trim.endMs);
          return;
        }
        onPlayheadMs(ms);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, trim.endMs, onPlayheadMs]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onFocusDone();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking, onFocusDone]);

  const seek = (ms: number) => {
    const video = videoRef.current;
    const target = clamp(ms, trim.startMs, trim.endMs);
    if (video) video.currentTime = target / 1000;
    onPlayheadMs(target);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    // Resuming from the end of the clip restarts it instead of playing the
    // untrimmed tail.
    const ms = video.currentTime * 1000;
    if (ms < trim.startMs || ms >= trim.endMs - 1) video.currentTime = trim.startMs / 1000;
    void video.play().catch(() => setPlaying(false));
  };

  /** Screen point to a 0..1 point on the output canvas. */
  const normalize = useCallback((clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  }, []);

  const pickFocus = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    onFocus(
      clamp((event.clientX - rect.left) / rect.width, 0, 1),
      clamp((event.clientY - rect.top) / rect.height, 0, 1),
    );
  };

  const pct = (value: number) => `${value * 100}%`;

  return (
    <>
      <div
        className="stage"
        ref={stageRef}
        style={{
          aspectRatio: `${out.width} / ${out.height}`,
          background: framing.background,
        }}
      >
        {/* The content box, exactly where `pad` puts it on the canvas. */}
        <div
          className="stage__frame"
          style={{
            left: pct(content.x / out.width),
            top: pct(content.y / out.height),
            width: pct(content.width / out.width),
            height: pct(content.height / out.height),
            borderRadius: layout.radiusPx * pxScale,
          }}
        >
          {previewUrl ? (
            // Two nested boxes: the inner one carries the crop (the video is
            // blown up so the kept region fills the frame) and the outer one
            // carries the zoom, whose translate is a percentage of the frame.
            <div
              className="stage__zoom"
              style={{
                transform: `scale(${window_.scale}) translate(${pct(-window_.x)}, ${pct(-window_.y)})`,
              }}
            >
              <video
                ref={videoRef}
                className="stage__video"
                src={previewUrl}
                preload="metadata"
                style={{
                  width: pct(1 / Math.max(0.05, crop.width)),
                  height: pct(1 / Math.max(0.05, crop.height)),
                  left: pct(-crop.x / Math.max(0.05, crop.width)),
                  top: pct(-crop.y / Math.max(0.05, crop.height)),
                }}
                onLoadedMetadata={(e) => {
                  setPreviewError(null);
                  e.currentTarget.currentTime = trim.startMs / 1000;
                }}
                onError={(e) => setPreviewError(describeMediaError(e.currentTarget.error))}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onSeeked={(e) => onPlayheadMs(Math.round(e.currentTarget.currentTime * 1000))}
              />
            </div>
          ) : (
            <div className="stage__placeholder">{t("edit.previewPlaceholder")}</div>
          )}

          {picking && (
            <div className="stage__pick" onClick={pickFocus}>
              <span
                className="stage__focus"
                style={{ left: pct(focusStop.cx), top: pct(focusStop.cy) }}
              />
            </div>
          )}
        </div>

        {/* Callouts are placed against the full canvas, padding included, the
            same as the `drawtext` stage that runs after `pad`. */}
        {pxScale > 0 &&
          project.callouts
            .filter((c) => c.text.trim().length > 0)
            .map((c) => (
              <StageCallout
                key={c.id}
                callout={c}
                pxScale={pxScale}
                canvasWidth={stageWidth}
                canvasHeight={stageWidth * (out.height / out.width)}
                active={
                  clipTimeMs >= c.t && clipTimeMs <= c.t + Math.max(200, c.durationMs)
                }
                onMove={onMoveCallout}
                normalize={normalize}
              />
            ))}

        {previewError && (
          <div className="stage__placeholder stage__placeholder--error">
            {t("edit.previewFailed", { reason: previewError })}
          </div>
        )}
      </div>

      {picking && (
        <div className="stage__hint">
          <span>{t("edit.focusHint")}</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={onFocusDone}>
            {t("edit.focusDone")}
          </button>
        </div>
      )}

      <div className="transport">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!previewUrl}
          onClick={togglePlay}
        >
          {playing ? `❙❙ ${t("edit.pause")}` : `▶ ${t("edit.play")}`}
        </button>
        <input
          type="range"
          min={trim.startMs}
          max={Math.max(trim.startMs + 1, trim.endMs)}
          step={10}
          value={clamp(playheadMs, trim.startMs, trim.endMs)}
          disabled={!previewUrl}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="transport__time">
          {formatDuration(clipTimeMs)} / {formatDuration(clipMs)}
        </span>
      </div>
    </>
  );
}

/**
 * One callout drawn over the stage. It measures itself because `drawtext`
 * clamps the box by its rendered size, and a box wide enough to hit the canvas
 * edge is pushed back in rather than centred — a difference the user would
 * otherwise only discover in the exported file.
 */
function StageCallout({
  callout,
  pxScale,
  canvasWidth,
  canvasHeight,
  active,
  onMove,
  normalize,
}: {
  callout: Callout;
  pxScale: number;
  canvasWidth: number;
  canvasHeight: number;
  active: boolean;
  onMove: (id: string, x: number, y: number) => void;
  normalize: (clientX: number, clientY: number) => { x: number; y: number } | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const left = clampTextBox(callout.x * canvasWidth, box.width, canvasWidth);
  const top = clampTextBox(callout.y * canvasHeight, box.height, canvasHeight);

  return (
    <div
      ref={ref}
      className={`stage__callout${active ? "" : " stage__callout--ghost"}${
        dragging ? " stage__callout--dragging" : ""
      }`}
      style={{
        left,
        top,
        color: callout.color,
        background: callout.boxColor,
        fontSize: Math.max(1, callout.fontSize * pxScale),
        padding: CALLOUT_BOX_BORDER_PX * pxScale,
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const point = normalize(e.clientX, e.clientY);
        if (point) onMove(callout.id, point.x, point.y);
      }}
      onPointerUp={(e) => {
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => setDragging(false)}
    >
      {callout.text}
    </div>
  );
}
