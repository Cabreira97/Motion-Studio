/** Time helpers shared by the UI, the render planner and the tests. */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Formats milliseconds as `mm:ss.d` (or `h:mm:ss.d` past an hour). */
export function formatDuration(msInput: number): string {
  const ms = Math.max(0, Math.floor(Number.isFinite(msInput) ? msInput : 0));
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const two = (n: number) => n.toString().padStart(2, "0");
  const core = `${two(minutes)}:${two(seconds)}.${tenths}`;
  return hours > 0 ? `${hours}:${core}` : core;
}

/** Formats milliseconds as a compact seconds value, e.g. `12.34`. */
export function toSeconds(ms: number): number {
  return Math.round((ms / 1000) * 1000) / 1000;
}

/** Turns seconds into ffmpeg's `HH:MM:SS.mmm` timecode. */
export function toTimecode(ms: number): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = Math.floor(safe % 1000);
  const two = (n: number) => n.toString().padStart(2, "0");
  const three = (n: number) => n.toString().padStart(3, "0");
  return `${two(hours)}:${two(minutes)}:${two(seconds)}.${three(millis)}`;
}

export function roundToFrame(ms: number, fps: number): number {
  if (!(fps > 0)) return Math.max(0, Math.round(ms));
  const frameMs = 1000 / fps;
  return roundMs(Math.round(ms / frameMs) * frameMs);
}

/** Kills floating-point noise from frame math (sub-microsecond). */
export function roundMs(ms: number): number {
  return Math.round(ms * 1e6) / 1e6;
}
