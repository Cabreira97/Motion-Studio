import { buildZoomTimeline, toClipTime } from "./cursor.js";
import { evenSize, getPreset, resolveOutputSize } from "./presets.js";
import { formatDuration } from "./time.js";
import { normalizeTrim } from "./trim.js";
import { clampRect } from "./validation.js";
import {
  buildManualTimeline,
  clampStop,
  normalizeStops,
  DEFAULT_STOP_MS,
  DEFAULT_STOP_SCALE,
} from "./zoom.js";
import {
  DEFAULT_CURSOR_STYLE,
  DEFAULT_FRAMING,
  FULL_CROP,
  type CaptureKind,
  type ExportArtifact,
  type Framing,
  type Project,
  type SourceMedia,
  type ZoomMode,
  type ZoomStop,
} from "./types.js";

export interface CreateProjectInput {
  id: string;
  name?: string;
  captureKind: CaptureKind;
  sourceLabel?: string;
  mic: boolean;
  source: SourceMedia;
  now?: number;
  /** Raw cursor samples captured while recording (normalized 0..1). */
  cursorTrack?: Project["cursorTrack"];
  presetId?: string;
}

/** Derives a canvas that matches the source aspect ratio (no letterboxing). */
export function deriveFraming(source: SourceMedia, presetId: string): Framing {
  const preset = getPreset(presetId);
  const aspect = source.width / source.height;
  let height = Math.min(1080, source.height || 1080);
  let width = Math.round(height * aspect);
  if (length(width, height) > 0 && (source.height <= 1080 || width <= 1920)) {
    // keep as-is
  } else {
    height = preset.maxHeight;
    width = Math.round(height * aspect);
  }
  const output = evenSize({ width, height });
  return { ...DEFAULT_FRAMING, outputWidth: output.width, outputHeight: output.height };
}

function length(width: number, height: number): number {
  return width * height;
}

export function timestampName(prefix: string, now: number): string {
  const d = new Date(now);
  const two = (n: number) => n.toString().padStart(2, "0");
  return `${prefix} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
}

export function createProject(input: CreateProjectInput): Project {
  const now = input.now ?? Date.now();
  const presetId = input.presetId ?? "mp4-1080p";
  const framing = deriveFraming(input.source, presetId);
  const trim = normalizeTrim(
    { startMs: 0, endMs: input.source.durationMs },
    input.source.durationMs,
    framing.fps,
  );

  const project: Project = {
    id: input.id,
    name: input.name?.trim() || timestampName("Recording", now),
    createdAt: now,
    updatedAt: now,
    capture: {
      kind: input.captureKind,
      sourceLabel: input.sourceLabel ?? "",
      mic: input.mic,
    },
    source: input.source,
    cursorTrack: input.cursorTrack ?? [],
    zoom: { enabled: true, mode: "auto", keyframes: [], stops: [], intensity: 0.45 },
    cursorStyle: { ...DEFAULT_CURSOR_STYLE },
    crop: { ...FULL_CROP },
    callouts: [],
    trim: { startMs: trim.startMs, endMs: trim.endMs },
    framing,
    export: { presetId },
    exports: [],
  };

  return withZoomTimeline(project);
}

/**
 * Recomputes the render-facing zoom keyframes from whichever source the
 * project's mode selects: the recorded cursor track, or hand-placed stops.
 *
 * Call this after anything that moves the trim or edits a zoom source — the
 * keyframes are clip-relative, so they go stale whenever the trim start moves.
 */
export function withZoomTimeline(
  project: Project,
  intensity = project.zoom.intensity,
): Project {
  if (!project.zoom.enabled) return { ...project, zoom: { ...project.zoom, intensity } };
  const durationMs = Math.max(0, project.trim.endMs - project.trim.startMs);
  const keyframes =
    project.zoom.mode === "manual"
      ? buildManualTimeline(project.zoom.stops, project.trim.startMs, {
          durationMs,
          smoothingMs: project.cursorStyle.smoothingMs,
        })
      : buildZoomTimeline(toClipTime(project.cursorTrack, project.trim.startMs, durationMs), {
          durationMs,
          intensity,
          smoothingMs: project.cursorStyle.smoothingMs,
        });
  return { ...project, zoom: { ...project.zoom, keyframes, intensity } };
}

/** Switches between cursor-driven and hand-placed zoom, keeping both sources. */
export function withZoomMode(project: Project, mode: ZoomMode): Project {
  return withZoomTimeline(touch({ ...project, zoom: { ...project.zoom, mode } }));
}

/** Replaces the manual stop list and rebuilds the timeline. */
export function withZoomStops(project: Project, stops: ZoomStop[]): Project {
  return withZoomTimeline(
    touch({ ...project, zoom: { ...project.zoom, stops: normalizeStops(stops) } }),
  );
}

/** Adds a stop at `t` (source time) focused on a normalized point. */
export function addZoomStop(
  project: Project,
  stop: { id: string; t: number; scale?: number; cx?: number; cy?: number; durationMs?: number },
): Project {
  return withZoomStops(project, [
    ...project.zoom.stops,
    {
      id: stop.id,
      t: stop.t,
      durationMs: stop.durationMs ?? DEFAULT_STOP_MS,
      scale: stop.scale ?? DEFAULT_STOP_SCALE,
      cx: stop.cx ?? 0.5,
      cy: stop.cy ?? 0.5,
    },
  ]);
}

export function removeZoomStop(project: Project, id: string): Project {
  return withZoomStops(
    project,
    project.zoom.stops.filter((s) => s.id !== id),
  );
}

export function updateZoomStop(
  project: Project,
  id: string,
  patch: Partial<Omit<ZoomStop, "id">>,
): Project {
  return withZoomStops(
    project,
    project.zoom.stops.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  );
}

/**
 * Fills in fields added after a project was saved.
 *
 * Projects are persisted as opaque JSON, so an older document simply lacks the
 * newer keys. Reading one must not crash the library view or silently produce
 * `undefined.length` further down.
 */
export function migrateProject(project: Project): Project {
  const zoom = project.zoom ?? { enabled: true, keyframes: [], intensity: 0.45 };
  return {
    ...project,
    cursorTrack: Array.isArray(project.cursorTrack) ? project.cursorTrack : [],
    callouts: Array.isArray(project.callouts) ? project.callouts : [],
    exports: Array.isArray(project.exports) ? project.exports : [],
    zoom: {
      enabled: zoom.enabled ?? true,
      mode: zoom.mode === "manual" ? "manual" : "auto",
      keyframes: Array.isArray(zoom.keyframes) ? zoom.keyframes : [],
      stops: Array.isArray(zoom.stops) ? zoom.stops.map(clampStop) : [],
      intensity: Number.isFinite(zoom.intensity) ? zoom.intensity : 0.45,
    },
  };
}

export function touch(project: Project, now = Date.now()): Project {
  return { ...project, updatedAt: now };
}

export function withCrop(project: Project, crop: Project["crop"]): Project {
  return touch({ ...project, crop: clampRect(crop) });
}

export function withTrim(project: Project, trim: Project["trim"]): Project {
  const source = project.source;
  const duration = source?.durationMs ?? Math.max(project.trim.endMs, trim.endMs);
  const normalized = normalizeTrim(trim, duration, project.framing.fps);
  const next = touch({
    ...project,
    trim: { startMs: normalized.startMs, endMs: normalized.endMs },
  });
  return withZoomTimeline(next);
}

export function withPreset(project: Project, presetId: string): Project {
  const preset = getPreset(presetId);
  const size = project.source
    ? resolveOutputSize(project.framing, preset)
    : { width: project.framing.outputWidth, height: project.framing.outputHeight };
  return touch({
    ...project,
    export: { presetId },
    framing: { ...project.framing, outputWidth: size.width, outputHeight: size.height },
  });
}

export function addExport(project: Project, artifact: ExportArtifact): Project {
  return touch({ ...project, exports: [artifact, ...project.exports] });
}

export function withExportDriveUrl(project: Project, exportId: string, driveUrl: string): Project {
  return touch({
    ...project,
    exports: project.exports.map((a) => (a.id === exportId ? { ...a, driveUrl } : a)),
  });
}

export function summarizeTrim(project: Project): string {
  const durationMs = Math.max(0, project.trim.endMs - project.trim.startMs);
  return `${formatDuration(project.trim.startMs)} → ${formatDuration(project.trim.endMs)} (${formatDuration(durationMs)})`;
}
