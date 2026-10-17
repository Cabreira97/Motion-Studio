/**
 * Manual zoom authoring.
 *
 * Auto-zoom needs the OS to report the global cursor position. Wayland
 * deliberately does not expose it, so on those sessions the cursor track is
 * empty and auto-zoom produces nothing. Manual stops are the fallback there,
 * and a useful tool on every other platform.
 *
 * A stop expands into the same keyframe shape `buildZoomTimeline` produces for
 * a cursor cluster — ease in, hold, ease out — so the renderer, the preview and
 * the ffmpeg expression builder all stay on one code path.
 */

import { dedupeKeyframes } from "./cursor.js";
import { clamp } from "./time.js";
import type { ZoomKeyframe, ZoomStop } from "./types.js";

/** Zoom bounds shared by the UI sliders and validation. */
export const MIN_ZOOM_SCALE = 1;
export const MAX_ZOOM_SCALE = 4;
/** A hold shorter than this reads as a twitch rather than a zoom. */
export const MIN_STOP_MS = 300;
export const DEFAULT_STOP_MS = 2000;
export const DEFAULT_STOP_SCALE = 1.8;

export interface ManualZoomOptions {
  /** Clip length in milliseconds (after the trim). */
  durationMs: number;
  /** Ease-in/ease-out ramp length. */
  smoothingMs?: number;
}

/** Forces a stop into the ranges the renderer and validation expect. */
export function clampStop(stop: ZoomStop): ZoomStop {
  return {
    ...stop,
    t: Math.max(0, Number.isFinite(stop.t) ? stop.t : 0),
    durationMs: Math.max(MIN_STOP_MS, Number.isFinite(stop.durationMs) ? stop.durationMs : DEFAULT_STOP_MS),
    scale: clamp(Number.isFinite(stop.scale) ? stop.scale : DEFAULT_STOP_SCALE, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE),
    cx: clamp(Number.isFinite(stop.cx) ? stop.cx : 0.5, 0, 1),
    cy: clamp(Number.isFinite(stop.cy) ? stop.cy : 0.5, 0, 1),
  };
}

/** Sorts stops by time and trims overlaps so one stop never starts inside another. */
export function normalizeStops(stops: ZoomStop[]): ZoomStop[] {
  const sorted = stops.map(clampStop).sort((a, b) => a.t - b.t);
  const out: ZoomStop[] = [];
  for (const stop of sorted) {
    const previous = out[out.length - 1];
    if (previous && stop.t < previous.t + previous.durationMs) {
      // Overlapping holds would fight over the focus point. Shorten the one
      // already placed rather than dropping the new one, which is what the
      // user just asked for.
      const shortened = Math.max(MIN_STOP_MS, stop.t - previous.t);
      if (previous.t + shortened <= stop.t) {
        out[out.length - 1] = { ...previous, durationMs: shortened };
      } else {
        // The earlier stop cannot be shortened enough to fit; skip the new one.
        continue;
      }
    }
    out.push(stop);
  }
  return out;
}

/**
 * Expands manual stops into a clip-relative keyframe timeline.
 *
 * `stops` are in source time; `startMs` is the trim start, so stops outside the
 * clip disappear exactly like cursor samples do in {@link toClipTime}.
 */
export function buildManualTimeline(
  stops: ZoomStop[],
  startMs: number,
  options: ManualZoomOptions,
): ZoomKeyframe[] {
  const durationMs = Math.max(0, options.durationMs);
  const smoothing = Math.max(120, options.smoothingMs ?? 450);

  const keyframes: ZoomKeyframe[] = [{ t: 0, scale: 1, cx: 0.5, cy: 0.5 }];

  for (const stop of normalizeStops(stops)) {
    const holdStart = stop.t - startMs;
    const holdEnd = holdStart + stop.durationMs;
    // Drop stops that fall entirely outside the trimmed clip.
    if (holdEnd <= 0 || holdStart >= durationMs) continue;

    const rampIn = Math.max(0, holdStart - smoothing);
    const rampOut = Math.min(durationMs, holdEnd + smoothing);

    keyframes.push({ t: rampIn, scale: 1, cx: 0.5, cy: 0.5 });
    keyframes.push({ t: Math.max(0, holdStart), scale: stop.scale, cx: stop.cx, cy: stop.cy });
    keyframes.push({ t: Math.min(durationMs, holdEnd), scale: stop.scale, cx: stop.cx, cy: stop.cy });
    keyframes.push({ t: rampOut, scale: 1, cx: 0.5, cy: 0.5 });
  }

  keyframes.push({ t: durationMs, scale: 1, cx: 0.5, cy: 0.5 });

  return dedupeKeyframes(keyframes.filter((k) => k.t >= 0 && k.t <= durationMs));
}
