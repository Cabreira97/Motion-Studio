import { clamp, roundMs, roundToFrame } from "./time.js";
import type { TrimRange } from "./types.js";

/** Smallest allowed clip length so an export always has at least a frame. */
export const MIN_CLIP_MS = 200;

export interface NormalizedTrim extends TrimRange {
  durationMs: number;
  frames: number;
}

/**
 * Clamps a non-destructive trim range to the media duration and snaps it to
 * frame boundaries for the given fps. Trimming never mutates the source file;
 * it only describes which window should be rendered.
 */
export function normalizeTrim(
  range: { startMs: number; endMs: number },
  durationMs: number,
  fps: number,
): NormalizedTrim {
  const total = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  const frameMs = fps > 0 ? 1000 / fps : 1000 / 30;

  let start = clamp(range.startMs, 0, Math.max(0, total - MIN_CLIP_MS));
  let end = clamp(range.endMs, start + MIN_CLIP_MS, total);

  if (total < MIN_CLIP_MS) {
    start = 0;
    end = Math.max(frameMs, total);
  }

  start = roundToFrame(start, fps);
  end = roundToFrame(end, fps);
  if (end <= start) end = roundMs(start + frameMs);

  const duration = Math.max(frameMs, end - start);
  const frames = Math.max(1, Math.round(duration / frameMs));
  const snappedStart = roundMs(start);
  const snappedEnd = roundMs(start + frames * frameMs);
  return {
    startMs: snappedStart,
    endMs: snappedEnd,
    durationMs: roundMs(snappedEnd - snappedStart),
    frames,
  };
}

/** Maps a time in the trimmed clip back to the original recording. */
export function sourceTimeFor(clipTimeMs: number, trim: TrimRange): number {
  return trim.startMs + clipTimeMs;
}

/** Maps a time in the original recording into trimmed-clip time, or -1. */
export function clipTimeFor(sourceTimeMs: number, trim: TrimRange): number {
  if (sourceTimeMs < trim.startMs || sourceTimeMs > trim.endMs) return -1;
  return sourceTimeMs - trim.startMs;
}
