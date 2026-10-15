import { evaluateZoom } from "./cursor.js";
import { getPreset, presetCodecArgs, resolveOutputSize, type ExportPreset } from "./presets.js";
import { normalizeTrim } from "./trim.js";
import { clamp, toSeconds } from "./time.js";
import type {
  Callout,
  CursorStyle,
  Framing,
  Point,
  Rect,
  ZoomKeyframe,
} from "./types.js";

export interface RenderPlan {
  sourcePath: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  hasAudio: boolean;
  trim: { startMs: number; endMs: number };
  crop: Rect;
  framing: Framing;
  zoom: { enabled: boolean; keyframes: ZoomKeyframe[] };
  cursor: { enabled: boolean; track: Point[] };
  cursorStyle: CursorStyle;
  callouts: Callout[];
  presetId: string;
  outputPath: string;
  /** Absolute path to a `.ttf`/`.otf` used for callouts, if any. */
  fontFile?: string;
  /** Optional path to a soft cursor-highlight PNG (input #1). */
  cursorOverlayPath?: string;
}

export interface BuiltGraph {
  filterComplex: string;
  videoMap: string;
  audioMap: string | null;
  inputPaths: string[];
}

function isFullCrop(rect: Rect): boolean {
  return (
    Math.abs(rect.x) < 1e-6 &&
    Math.abs(rect.y) < 1e-6 &&
    Math.abs(rect.width - 1) < 1e-6 &&
    Math.abs(rect.height - 1) < 1e-6
  );
}

function evenBelow(value: number, floor: number): number {
  const rounded = Math.floor(value / 2) * 2;
  return Math.max(floor, rounded);
}

/** Resolves a normalized crop rect to even pixel dimensions inside the source. */
export function computeCropPixels(srcW: number, srcH: number, rect: Rect) {
  const width = evenBelow(clamp(rect.width, 0.05, 1) * srcW, 2);
  const height = evenBelow(clamp(rect.height, 0.05, 1) * srcH, 2);
  const maxX = Math.max(0, srcW - width);
  const maxY = Math.max(0, srcH - height);
  const x = evenBelow(clamp(rect.x, 0, 1) * srcW, 0);
  const y = evenBelow(clamp(rect.y, 0, 1) * srcH, 0);
  return { width, height, x: Math.min(x, maxX), y: Math.min(y, maxY) };
}

/**
 * Emits a compact ffmpeg expression that reproduces the eased zoom curve.
 * The curve is piecewise cubic-ease-in-out between consecutive keyframes,
 * exactly matching {@link evaluateZoom}.
 *
 * `selector` picks which channel (scale/cx/cy) of a keyframe to interpolate.
 * `timeVar` is the ffmpeg time variable to use (zoompan exposes `on`, the
 * other filters expose `t`), always expressed in seconds.
 */
export function buildZoomExpression(
  keyframes: ZoomKeyframe[],
  selector: "scale" | "cx" | "cy",
  timeVar = "t",
): string {
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return "1";
  const value = (kf: ZoomKeyframe) => kf[selector];

  if (sorted.length === 1) return `${value(sorted[0]!)}`;

  const lines: string[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const span = Math.max(1e-6, b.t - a.t);
    const t0 = toSeconds(a.t);
    const spanSec = span / 1000;
    const va = value(a);
    const vb = value(b);
    // p = (time - t0)/span ; eased = cubic ease-in-out(p)
    const p = `(${timeVar}-${t0})/${spanSec}`;
    const eased = `if(lt(${p},0.5),4*${p}*${p}*${p},1-pow(2-2*${p},3)/2)`;
    const seg = `${va}+(${vb - va})*${eased}`;
    lines.push(`if(lt(${timeVar},${toSeconds(b.t)}),${seg},`);
  }
  const fallback = `${value(sorted[sorted.length - 1]!)}`;
  return `${lines.join("")}${fallback}${")".repeat(lines.length)}`;
}

/** Escapes a string for use inside an ffmpeg drawtext `text=` value. */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, "\\n")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** Escapes a filesystem path for an ffmpeg filter argument. */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildCalloutFilters(callouts: Callout[], framing: Framing): string[] {
  const { outputWidth: W, outputHeight: H } = framing;
  return callouts
    .filter((c) => c.text.trim().length > 0)
    .map((c) => {
      const start = toSeconds(Math.max(0, c.t));
      const end = toSeconds(Math.max(0, c.t + Math.max(200, c.durationMs)));
      const x = clamp(c.x, 0, 1);
      const y = clamp(c.y, 0, 1);
      const px = `max(0\\,min(${W}-text_w\\,${Math.round(x * W)}-text_w/2))`;
      const py = `max(0\\,min(${H}-text_h\\,${Math.round(y * H)}-text_h/2))`;
      const color = c.color.replace(/[^#0-9a-fA-F@.]/g, "");
      const box = c.boxColor.replace(/[^#0-9a-fA-F@.]/g, "");
      return (
        `drawtext=text='${escapeDrawtext(c.text)}'` +
        `:fontsize=${Math.round(Math.max(8, c.fontSize))}` +
        `:fontcolor=${color}` +
        `:box=1:boxcolor=${box}:boxborderw=14` +
        `:x=${px}:y=${py}` +
        `:enable='between(t\\,${start}\\,${end})'`
      );
    });
}

/** Normalizes the cursor track into `base`-pixel coordinates for overlaying. */
function cursorPositionExpr(
  track: Point[],
  crop: Rect,
  baseW: number,
  baseH: number,
): { x: string; y: string } {
  const cropW = Math.max(1e-6, crop.width);
  const cropH = Math.max(1e-6, crop.height);
  const rel = track
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      t: p.t,
      x: clamp((p.x - crop.x) / cropW, -0.5, 1.5) * baseW,
      y: clamp((p.y - crop.y) / cropH, -0.5, 1.5) * baseH,
    }));

  const build = (sel: "x" | "y") => {
    if (rel.length === 0) return `${sel === "x" ? baseW / 2 : baseH / 2}`;
    if (rel.length === 1) return `${rel[0]![sel]}`;
    const parts: string[] = [];
    for (let i = 1; i < rel.length; i += 1) {
      const a = rel[i - 1]!;
      const b = rel[i]!;
      const span = Math.max(1e-6, (b.t - a.t) / 1000);
      const p = `(t-${toSeconds(a.t)})/${span}`;
      const seg = `${a[sel]}+${b[sel] - a[sel]}*${p}`;
      parts.push(`if(lt(t,${toSeconds(b.t)}),${seg},`);
    }
    return `${parts.join("")}${rel[rel.length - 1]![sel]}${")".repeat(parts.length)}`;
  };

  return { x: build("x"), y: build("y") };
}

function zoompanExpr(plan: RenderPlan, baseW: number, baseH: number) {
  // zoompan exposes the current zoom as `zoom` and the output frame number as
  // `on`; converting to seconds keeps a single, well-tested time source.
  const timeVar = `(on/${plan.framing.fps})`;
  const z = buildZoomExpression(plan.zoom.keyframes, "scale", timeVar);
  const cx = buildZoomExpression(plan.zoom.keyframes, "cx", timeVar);
  const cy = buildZoomExpression(plan.zoom.keyframes, "cy", timeVar);
  const zExpr = `max(1\\,${z})`;
  const xExpr = `max(0\\,min(${baseW}-${baseW}/zoom\\,${baseW}*(${cx}-1/(2*zoom))))`;
  const yExpr = `max(0\\,min(${baseH}-${baseH}/zoom\\,${baseH}*(${cy}-1/(2*zoom))))`;
  // Output the same size as the (cropped) input so the aspect ratio is kept;
  // the fit+pad stages below handle the final canvas.
  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${baseW}x${baseH}:fps=${plan.framing.fps}`;
}

/**
 * Builds the full `-filter_complex` graph plus input list for a render plan.
 * Kept pure so it can be unit tested and mirrored by the Rust executor.
 */
export function buildGraph(plan: RenderPlan): BuiltGraph {
  const { framing, crop } = plan;
  const preset: ExportPreset = getPreset(plan.presetId);

  const normalized = normalizeTrim(plan.trim, Number.MAX_SAFE_INTEGER, framing.fps);
  const startSec = toSeconds(normalized.startMs);
  const endSec = toSeconds(normalized.endMs);
  const out = resolveOutputSize(framing, preset);

  const cropPixels = computeCropPixels(plan.sourceWidth, plan.sourceHeight, crop);
  const baseW = cropPixels.width;
  const baseH = cropPixels.height;

  const contentW = evenBelow(out.width - framing.paddingPx * 2, 2);
  const contentH = evenBelow(out.height - framing.paddingPx * 2, 2);

  const inputs: string[] = [plan.sourcePath];
  const filters: string[] = [];

  const baseParts = [
    `trim=start=${startSec}:end=${endSec}`,
    "setpts=PTS-STARTPTS",
    `fps=${framing.fps}`,
  ];
  if (!isFullCrop(crop)) {
    baseParts.push(
      `crop=${cropPixels.width}:${cropPixels.height}:${cropPixels.x}:${cropPixels.y}`,
    );
  }

  const useCursor = plan.cursor.enabled && plan.cursor.track.length > 0 && !!plan.cursorOverlayPath;

  if (useCursor) {
    inputs.push(plan.cursorOverlayPath!);
    const { x, y } = cursorPositionExpr(plan.cursor.track, crop, baseW, baseH);
    filters.push(`[0:v]${baseParts.join(",")}[base]`);
    const diameter = evenBelow(framing.outputHeight * plan.cursorStyle.radiusScale * 2, 8);
    filters.push(
      `[1:v]scale=${diameter}:${diameter}:flags=bicubic,format=rgba,loop=loop=-1:size=1:start=0[cur]`,
    );
    const end = endSec;
    filters.push(
      `[base][cur]overlay=x='${x}-${diameter}/2':y='${y}-${diameter}/2':eval=frame:shortest=1:enable='between(t\\,0\\,${end})'[based]`,
    );
  } else {
    filters.push(`[0:v]${baseParts.join(",")}[based]`);
  }

  let current = "based";
  if (plan.zoom.enabled && plan.zoom.keyframes.length > 0) {
    filters.push(`[${current}]${zoompanExpr(plan, baseW, baseH)}[zoomed]`);
    current = "zoomed";
  }

  filters.push(
    `[${current}]scale=${contentW}:${contentH}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fit]`,
  );
  filters.push(
    `[fit]pad=${out.width}:${out.height}:(ow-iw)/2:(oh-ih)/2:color=${framing.background}[padded]`,
  );
  current = "padded";

  const calloutFilters = plan.fontFile
    ? buildCalloutFilters(plan.callouts, {
        ...framing,
        outputWidth: out.width,
        outputHeight: out.height,
      })
    : [];
  if (calloutFilters.length > 0) {
    const fontArg = `:fontfile='${escapeFilterPath(plan.fontFile!)}'`;
    const chain = calloutFilters.map((f) => `${f}${fontArg}`).join(",");
    filters.push(`[padded]${chain}[withtext]`);
    current = "withtext";
  }

  filters.push(`[${current}]format=${preset.pixelFormat}[vout]`);

  let audioMap: string | null = null;
  if (plan.hasAudio) {
    filters.push(`[0:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[aout]`);
    audioMap = "[aout]";
  }

  return {
    filterComplex: filters.join(";"),
    videoMap: "[vout]",
    audioMap,
    inputPaths: inputs,
  };
}

/** Full ffmpeg argv (argv[0] is the literal "ffmpeg"; the runner resolves it). */
export function buildRenderArgs(plan: RenderPlan): string[] {
  const graph = buildGraph(plan);
  const preset = getPreset(plan.presetId);
  const args = [
    "ffmpeg",
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    plan.sourcePath,
  ];
  if (graph.inputPaths.length > 1) {
    // Looped still image for the cursor highlight.
    args.push("-loop", "1", "-i", graph.inputPaths[1]!);
  }
  args.push(
    "-filter_complex",
    graph.filterComplex,
    "-map",
    graph.videoMap,
  );
  if (graph.audioMap) {
    args.push("-map", graph.audioMap);
  }
  args.push(...presetCodecArgs(preset, plan.hasAudio));
  args.push("-r", String(plan.framing.fps), "-t", String(toSeconds(normalizeTrim(plan.trim, Number.MAX_SAFE_INTEGER, plan.framing.fps).durationMs)));
  args.push(plan.outputPath);
  return args;
}

export function buildPosterArgs(videoPath: string, atMs: number, outputPath: string): string[] {
  return [
    "ffmpeg",
    "-y",
    "-hide_banner",
    "-nostdin",
    "-ss",
    String(toSeconds(Math.max(0, atMs))),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ];
}

export function buildProbeArgs(filePath: string): string[] {
  return [
    "ffprobe",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ];
}

/** Picks a poster timestamp: a little into the clip, avoiding a black first frame. */
export function choosePosterTime(trim: { startMs: number; endMs: number }, atMs?: number): number {
  if (typeof atMs === "number") return clamp(atMs, trim.startMs, trim.endMs);
  const span = Math.max(0, trim.endMs - trim.startMs);
  return trim.startMs + Math.min(span / 2, Math.max(200, span * 0.25));
}
