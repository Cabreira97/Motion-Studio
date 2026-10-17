import { clamp } from "./time.js";
import type { Point, ZoomKeyframe } from "./types.js";

export interface ZoomBuildOptions {
  durationMs: number;
  /** 0..1 user "intensity" slider; maps to max zoom scale. */
  intensity?: number;
  smoothingMs?: number;
  /** Minimum dwell between zoom moves. */
  minDwellMs?: number;
  baseScale?: number;
  nowMs?: number;
}

const DEFAULT_MIN_DWELL = 900;

/**
 * Shifts a raw cursor track from source time into clip time.
 *
 * Recording samples are stamped from the start of the capture, but everything
 * downstream of the trim (`setpts=PTS-STARTPTS`) sees time starting at 0. Both
 * the zoom timeline and the cursor-highlight overlay must therefore use the
 * same shifted track, or the highlight drifts by exactly the trim offset.
 *
 * Samples outside the clip are dropped: they cannot be drawn and would only
 * stretch the interpolation between the frames that can.
 */
export function toClipTime(track: Point[], startMs: number, durationMs?: number): Point[] {
  const limit = typeof durationMs === "number" ? Math.max(0, durationMs) : Infinity;
  return track
    .filter((p) => Number.isFinite(p.t))
    .map((p) => ({ ...p, t: p.t - startMs }))
    .filter((p) => p.t >= 0 && p.t <= limit);
}

/** Cubic ease-in-out on a normalized 0..1 progress value. */
export function easeInOut(progress: number): number {
  const p = clamp(progress, 0, 1);
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Intensity slider (0..1) -> max zoom scale (1.0x .. 2.5x). */
export function scaleForIntensity(intensity: number): number {
  return 1 + clamp(intensity, 0, 1) * 1.5;
}

interface Cluster {
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  weight: number;
}

/**
 * Groups pointer samples into "activity clusters" — contiguous stretches
 * where the cursor is doing something interesting (typing, clicking, drawing).
 * Long idle gaps split clusters so the zoom frames what the user is doing.
 */
export function clusterCursor(points: Point[], idleGapMs = 1200): Cluster[] {
  const sorted = [...points].filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];

  const clusters: Cluster[] = [];
  let current: Point[] = [sorted[0]!];

  const flush = () => {
    if (current.length === 0) return;
    const x = current.reduce((acc, p) => acc + p.x, 0) / current.length;
    const y = current.reduce((acc, p) => acc + p.y, 0) / current.length;
    clusters.push({
      startMs: current[0]!.t,
      endMs: current[current.length - 1]!.t,
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      weight: current.length,
    });
    current = [];
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    const gap = next.t - prev.t;
    const moved = Math.hypot(next.x - prev.x, next.y - prev.y);
    if (gap > idleGapMs || moved > 0.35) {
      // End the current cluster *before* starting a new one with `next`.
      flush();
      current.push(next);
    } else {
      current.push(next);
    }
  }
  flush();

  return clusters;
}

/**
 * Builds a smooth, eased zoom timeline from a raw cursor track.
 *
 * The result always starts and ends at 1x so the video opens and closes on the
 * full frame, and each cluster of activity produces a dwell at the zoomed
 * level with eased transitions in between.
 */
export function buildZoomTimeline(
  points: Point[],
  options: ZoomBuildOptions,
): ZoomKeyframe[] {
  const durationMs = Math.max(0, options.durationMs);
  const baseScale = options.baseScale ?? 1;
  const maxScale = scaleForIntensity(options.intensity ?? 0.5);
  const smoothing = Math.max(120, options.smoothingMs ?? 450);
  const minDwell = Math.max(200, options.minDwellMs ?? DEFAULT_MIN_DWELL);

  const keyframes: ZoomKeyframe[] = [
    { t: 0, scale: baseScale, cx: 0.5, cy: 0.5 },
  ];

  const clusters = clusterCursor(points, Math.max(600, smoothing * 2));
  if (clusters.length === 0 || durationMs <= 0) {
    keyframes.push({ t: durationMs, scale: baseScale, cx: 0.5, cy: 0.5 });
    return keyframes;
  }

  for (const cluster of clusters) {
    const zoomInStart = Math.max(0, cluster.startMs - smoothing);
    const zoomOutEnd = Math.min(durationMs, cluster.endMs + smoothing);

    // Keep a dwell long enough to be readable.
    const dwellEnd = Math.max(zoomInStart + minDwell, cluster.endMs);

    keyframes.push({ t: zoomInStart, scale: baseScale, cx: 0.5, cy: 0.5 });
    keyframes.push({ t: cluster.startMs, scale: maxScale, cx: cluster.x, cy: cluster.y });
    keyframes.push({ t: dwellEnd, scale: maxScale, cx: cluster.x, cy: cluster.y });
    keyframes.push({ t: Math.min(durationMs, zoomOutEnd), scale: baseScale, cx: 0.5, cy: 0.5 });
  }

  keyframes.push({ t: durationMs, scale: baseScale, cx: 0.5, cy: 0.5 });

  return dedupeKeyframes(keyframes.filter((k) => k.t >= 0 && k.t <= durationMs));
}

/** Sorts by time and removes stale/duplicate entries (keeps the last). */
export function dedupeKeyframes(keyframes: ZoomKeyframe[]): ZoomKeyframe[] {
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const out: ZoomKeyframe[] = [];
  for (const kf of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - kf.t) < 1e-6) {
      out[out.length - 1] = kf;
    } else {
      out.push(kf);
    }
  }
  return out;
}

/**
 * Evaluates the eased zoom timeline at a given time. This is the single source
 * of truth used both for the live preview and for the exported ffmpeg graph.
 */
export function evaluateZoom(
  keyframes: ZoomKeyframe[],
  t: number,
  fallbackScale = 1,
): { scale: number; cx: number; cy: number } {
  if (keyframes.length === 0) return { scale: fallbackScale, cx: 0.5, cy: 0.5 };
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  if (t <= first.t) return { scale: first.scale, cx: first.cx, cy: first.cy };
  if (t >= last.t) return { scale: last.scale, cx: last.cx, cy: last.cy };

  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const raw = span <= 0 ? 0 : (t - a.t) / span;
      const p = easeInOut(raw);
      return {
        scale: lerp(a.scale, b.scale, p),
        cx: lerp(a.cx, b.cx, p),
        cy: lerp(a.cy, b.cy, p),
      };
    }
  }
  return { scale: last.scale, cx: last.cx, cy: last.cy };
}
