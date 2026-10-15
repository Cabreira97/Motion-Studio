import { clamp } from "./time.js";
import { MIN_CLIP_MS } from "./trim.js";
import { MAX_ZOOM_SCALE, MIN_STOP_MS, MIN_ZOOM_SCALE } from "./zoom.js";
import type { Callout, Point, Project, Rect, ZoomKeyframe, ZoomStop } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export const MAX_NAME_LENGTH = 120;
export const MAX_CALLOUT_LENGTH = 280;
export const MAX_CURSOR_POINTS = 200_000;
export const MAX_CALLOUTS = 200;
export const MAX_KEYFRAMES = 5_000;
export const MAX_ZOOM_STOPS = 500;

const HEX_COLOR =
  /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(@(0|1|0?\.[0-9]{1,3}))?$/;

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_NAME_LENGTH
  );
}

export function clampRect(rect: Rect): Rect {
  const width = clamp(rect.width, 0.05, 1);
  const height = clamp(rect.height, 0.05, 1);
  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  };
}

export function validateCallout(callout: Callout, index: number): string[] {
  const errors: string[] = [];
  const label = `callout[${index}]`;
  if (typeof callout.text !== "string") errors.push(`${label}: text must be a string`);
  else if (callout.text.length > MAX_CALLOUT_LENGTH)
    errors.push(`${label}: text exceeds ${MAX_CALLOUT_LENGTH} characters`);
  if (!Number.isFinite(callout.t) || callout.t < 0) errors.push(`${label}: invalid start time`);
  if (!Number.isFinite(callout.durationMs) || callout.durationMs < 200)
    errors.push(`${label}: duration must be >= 200ms`);
  if (!Number.isFinite(callout.x) || !Number.isFinite(callout.y))
    errors.push(`${label}: invalid position`);
  if (!isValidColor(callout.color)) errors.push(`${label}: invalid text color`);
  if (!isValidColor(callout.boxColor)) errors.push(`${label}: invalid box color`);
  return errors;
}

export function validateCursorTrack(track: Point[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(track)) return ["cursorTrack must be an array"];
  if (track.length > MAX_CURSOR_POINTS)
    errors.push(`cursorTrack exceeds ${MAX_CURSOR_POINTS} points`);
  for (let i = 0; i < track.length; i += 1) {
    const p = track[i]!;
    if (!Number.isFinite(p.t) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      errors.push(`cursorTrack[${i}] is not finite`);
      break;
    }
  }
  return errors;
}

export function validateKeyframes(keyframes: ZoomKeyframe[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(keyframes)) return ["zoom.keyframes must be an array"];
  if (keyframes.length > MAX_KEYFRAMES)
    errors.push(`zoom.keyframes exceeds ${MAX_KEYFRAMES} entries`);
  for (let i = 0; i < keyframes.length; i += 1) {
    const k = keyframes[i]!;
    if (!Number.isFinite(k.t) || k.t < 0) errors.push(`zoom.keyframes[${i}]: invalid time`);
    if (!Number.isFinite(k.scale) || k.scale < 1) errors.push(`zoom.keyframes[${i}]: scale must be >= 1`);
  }
  return errors;
}

export function validateZoomStops(stops: ZoomStop[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(stops)) return ["zoom.stops must be an array"];
  if (stops.length > MAX_ZOOM_STOPS) errors.push(`zoom.stops exceeds ${MAX_ZOOM_STOPS} entries`);
  const seen = new Set<string>();
  for (let i = 0; i < stops.length; i += 1) {
    const s = stops[i]!;
    const label = `zoom.stops[${i}]`;
    if (!s.id) errors.push(`${label}: id is required`);
    else if (seen.has(s.id)) errors.push(`${label}: duplicate id "${s.id}"`);
    else seen.add(s.id);
    if (!Number.isFinite(s.t) || s.t < 0) errors.push(`${label}: invalid time`);
    if (!Number.isFinite(s.durationMs) || s.durationMs < MIN_STOP_MS)
      errors.push(`${label}: duration must be >= ${MIN_STOP_MS}ms`);
    if (!Number.isFinite(s.scale) || s.scale < MIN_ZOOM_SCALE || s.scale > MAX_ZOOM_SCALE)
      errors.push(`${label}: scale must be ${MIN_ZOOM_SCALE}..${MAX_ZOOM_SCALE}`);
    if (!Number.isFinite(s.cx) || !Number.isFinite(s.cy))
      errors.push(`${label}: invalid focus point`);
  }
  return errors;
}

/** Validates a full project before it is persisted or exported. */
export function validateProject(project: Project): ValidationResult {
  const errors: string[] = [];

  if (!isValidName(project.name)) errors.push("name must be 1..120 characters");
  if (!project.id) errors.push("id is required");
  if (!project.source) errors.push("source recording is required");

  if (project.source) {
    if (!Number.isFinite(project.source.width) || project.source.width <= 0)
      errors.push("source.width must be positive");
    if (!Number.isFinite(project.source.height) || project.source.height <= 0)
      errors.push("source.height must be positive");
    if (!project.source.path) errors.push("source.path is required");
  }

  if (project.trim.endMs - project.trim.startMs < MIN_CLIP_MS)
    errors.push(`trim range must be at least ${MIN_CLIP_MS}ms`);

  if (project.framing.paddingPx < 0) errors.push("framing.paddingPx must be >= 0");
  if (!isValidColor(project.framing.background)) errors.push("framing.background must be a hex color");
  if (project.framing.fps <= 0 || project.framing.fps > 240) errors.push("framing.fps out of range");

  errors.push(...validateCursorTrack(project.cursorTrack));
  errors.push(...validateKeyframes(project.zoom.keyframes));
  errors.push(...validateZoomStops(project.zoom.stops ?? []));
  if (project.callouts.length > MAX_CALLOUTS) errors.push(`too many callouts (max ${MAX_CALLOUTS})`);
  project.callouts.forEach((c, i) => errors.push(...validateCallout(c, i)));

  return { valid: errors.length === 0, errors };
}

/** Throws a descriptive error if validation fails (used before export). */
export function assertValidProject(project: Project): void {
  const result = validateProject(project);
  if (!result.valid) {
    throw new Error(`Invalid project: ${result.errors.join("; ")}`);
  }
}
