/**
 * Core domain types for Motion Studio, a local-first screen recorder.
 *
 * Everything here is plain data so it can be persisted as JSON in the local
 * SQLite store and passed between the React UI and the Rust/Tauri layer.
 */

export type CaptureKind = "screen" | "window" | "region";

/** A pointer sample. `x`/`y` are normalized to 0..1 of the captured surface. */
export interface Point {
  t: number;
  x: number;
  y: number;
}

/** Normalized rectangle (0..1) relative to the source frame. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A single zoom keyframe. `cx`/`cy` are normalized focus points. */
export interface ZoomKeyframe {
  t: number;
  scale: number;
  cx: number;
  cy: number;
}

/**
 * Where the zoom keyframes come from.
 *
 * `auto` derives them from the recorded cursor track. That needs the OS to
 * report the global cursor position, which Wayland deliberately does not, so
 * `manual` lets the user author the same timeline by hand — it is the only
 * zoom available on Wayland, and useful everywhere else.
 */
export type ZoomMode = "auto" | "manual";

/**
 * A user-authored zoom moment: hold `scale` on (`cx`, `cy`) for `durationMs`,
 * easing in before and out after. Times are in *source* time, like the trim,
 * so a stop keeps pointing at the same frame when the trim moves.
 */
export interface ZoomStop {
  id: string;
  t: number;
  durationMs: number;
  scale: number;
  cx: number;
  cy: number;
}

export interface Callout {
  id: string;
  t: number;
  durationMs: number;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  boxColor: string;
}

export interface CursorStyle {
  highlight: boolean;
  /** Highlight radius as a fraction of the output height. */
  radiusScale: number;
  smoothingMs: number;
  zoomFollow: boolean;
}

export interface TrimRange {
  startMs: number;
  endMs: number;
}

export interface Framing {
  paddingPx: number;
  background: string;
  cornerRadiusPx: number;
  /** Aspect-preserving canvas size in pixels (even numbers). */
  outputWidth: number;
  outputHeight: number;
  fps: number;
}

export interface ExportSettings {
  presetId: string;
}

export interface ExportArtifact {
  id: string;
  createdAt: number;
  presetId: string;
  videoPath: string;
  posterPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  bytes: number;
  durationMs: number;
}

export interface SourceMedia {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  capture: {
    kind: CaptureKind;
    sourceLabel: string;
    mic: boolean;
  };
  source: SourceMedia | null;
  cursorTrack: Point[];
  zoom: {
    enabled: boolean;
    mode: ZoomMode;
    /** Render input, always clip-relative. Derived — never edited directly. */
    keyframes: ZoomKeyframe[];
    /** Source for `mode: "manual"`. Ignored in `auto`, but kept so toggling back and forth is lossless. */
    stops: ZoomStop[];
    /** Source for `mode: "auto"`: 0..1 slider mapped to a max zoom scale. */
    intensity: number;
  };
  cursorStyle: CursorStyle;
  crop: Rect;
  callouts: Callout[];
  trim: TrimRange;
  framing: Framing;
  export: ExportSettings;
  exports: ExportArtifact[];
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  available: boolean;
  reason?: string;
  language?: string;
  segments: TranscriptSegment[];
  text: string;
}

export const DEFAULT_FRAMING: Framing = {
  paddingPx: 64,
  background: "#0f1115",
  cornerRadiusPx: 12,
  outputWidth: 1920,
  outputHeight: 1080,
  fps: 30,
};

export const DEFAULT_CURSOR_STYLE: CursorStyle = {
  highlight: true,
  radiusScale: 0.06,
  smoothingMs: 450,
  zoomFollow: true,
};

export const FULL_CROP: Rect = { x: 0, y: 0, width: 1, height: 1 };
