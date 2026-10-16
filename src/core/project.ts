import { buildZoomTimeline } from "./cursor.js";
import { evenSize, getPreset, resolveOutputSize } from "./presets.js";
import { formatDuration } from "./time.js";
import { normalizeTrim } from "./trim.js";
import { clampRect } from "./validation.js";
import {
  DEFAULT_CURSOR_STYLE,
  DEFAULT_FRAMING,
  FULL_CROP,
  type CaptureKind,
  type ExportArtifact,
  type Framing,
  type Project,
  type SourceMedia,
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
    zoom: { enabled: true, keyframes: [], intensity: 0.45 },
    cursorStyle: { ...DEFAULT_CURSOR_STYLE },
    crop: { ...FULL_CROP },
    callouts: [],
    trim: { startMs: trim.startMs, endMs: trim.endMs },
    framing,
    export: { presetId },
    exports: [],
  };

  return withAutoZoom(project);
}

/** Recomputes the zoom keyframes from the cursor track + current trim. */
export function withAutoZoom(
  project: Project,
  intensity = project.zoom.intensity,
): Project {
  if (!project.zoom.enabled) return { ...project, zoom: { ...project.zoom, intensity } };
  const durationMs = Math.max(0, project.trim.endMs - project.trim.startMs);
  const keyframes = buildZoomTimeline(
    // Shift the raw track into clip-relative time.
    project.cursorTrack.map((p) => ({ ...p, t: p.t - project.trim.startMs })),
    { durationMs, intensity, smoothingMs: project.cursorStyle.smoothingMs },
  );
  return { ...project, zoom: { keyframes, enabled: project.zoom.enabled, intensity } };
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
  return withAutoZoom(next);
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
