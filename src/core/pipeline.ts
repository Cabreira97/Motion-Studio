import { toClipTime } from "./cursor.js";
import { safeFilename } from "./filenames.js";
import {
  buildPosterArgs,
  buildRenderArgs,
  choosePosterTime,
  type RenderPlan,
} from "./filtergraph.js";
import { buildSummaryMarkdown } from "./markdown.js";
import { getPreset, resolveOutputSize } from "./presets.js";
import { renderCursorSprite, renderRoundedCornerMask } from "./png.js";
import {
  lastLines,
  ProcessError,
  resolveUniqueStem,
  type MediaPorts,
} from "./ports.js";
import { transcriptToPlainText } from "./transcript.js";
import { normalizeTrim } from "./trim.js";
import { clamp } from "./time.js";
import { assertValidProject } from "./validation.js";
import type { ExportArtifact, Project, Transcript } from "./types.js";

export interface ExportRequest {
  project: Project;
  outputDir: string;
  presetId?: string;
  posterAtMs?: number;
  /** Optional explicit font for callouts; required only if callouts exist. */
  fontFile?: string;
  /** Optional pre-rendered cursor sprite path. */
  cursorOverlayPath?: string;
}

export interface ExportResult {
  artifact: ExportArtifact;
  transcript: Transcript;
  summaryMarkdown: string;
  jobs: string[][];
  warnings: string[];
}

/**
 * The one-shot happy path: trim + auto-zoom + padding + cursor + callouts are
 * rendered locally through ffmpeg, then a poster frame, transcript and
 * Markdown summary are written alongside the video. Non-destructive: the raw
 * recording is never modified.
 */
export async function runExport(
  request: ExportRequest,
  ports: MediaPorts,
): Promise<ExportResult> {
  const warnings: string[] = [];
  const project = request.project;
  assertValidProject(project);

  if (!project.source) throw new Error("Project has no source recording");

  const preset = getPreset(request.presetId ?? project.export.presetId);
  const outputSize = resolveOutputSize(project.framing, preset);
  const normalized = normalizeTrim(
    project.trim,
    project.source.durationMs,
    project.framing.fps,
  );

  await ports.mkdirp(request.outputDir);
  const stem = await resolveUniqueStem(
    request.outputDir,
    safeFilename(project.name, { fallback: "recording" }),
    preset.extension,
    ports,
  );

  const videoPath = ports.join(request.outputDir, `${stem}.${preset.extension}`);
  const posterPath = ports.join(request.outputDir, `${stem}.poster.jpg`);
  const transcriptTxtPath = ports.join(request.outputDir, `${stem}.transcript.txt`);
  const transcriptJsonPath = ports.join(request.outputDir, `${stem}.transcript.json`);
  const summaryPath = ports.join(request.outputDir, `${stem}.md`);

  // --- cursor highlight sprite -------------------------------------------------
  // The overlay is drawn after the trim, so it needs the same clip-relative
  // track the zoom keyframes were built from.
  const cursorTrack = toClipTime(
    project.cursorTrack,
    normalized.startMs,
    normalized.durationMs,
  );
  let cursorOverlayPath = request.cursorOverlayPath;
  const cursorEnabled = project.cursorStyle.highlight && cursorTrack.length > 0;
  if (cursorEnabled && !cursorOverlayPath) {
    const spriteSize = clamp(
      Math.round(outputSize.height * project.cursorStyle.radiusScale * 2),
      16,
      256,
    );
    const sprite = renderCursorSprite({ size: spriteSize });
    const assetsDir = ports.join(request.outputDir, ".assets");
    await ports.mkdirp(assetsDir);
    cursorOverlayPath = ports.join(assetsDir, "cursor-sprite.png");
    await ports.writeBinary(cursorOverlayPath, sprite);
  }

  // --- rounded framing wedge ---------------------------------------------------
  let cornerMaskPath: string | undefined;
  const cornerRadius = Math.round(project.framing.cornerRadiusPx);
  if (cornerRadius > 0) {
    const assetsDir = ports.join(request.outputDir, ".assets");
    await ports.mkdirp(assetsDir);
    cornerMaskPath = ports.join(assetsDir, `corner-${cornerRadius}.png`);
    await ports.writeBinary(
      cornerMaskPath,
      renderRoundedCornerMask({
        radius: cornerRadius,
        background: project.framing.background,
      }),
    );
  }

  // --- plan + render -----------------------------------------------------------
  const callouts = project.callouts.filter((c) => c.text.trim().length > 0);
  if (callouts.length > 0 && !request.fontFile) {
    warnings.push("Callouts were skipped because no callout font was available.");
  }

  const plan: RenderPlan = {
    sourcePath: project.source.path,
    sourceWidth: project.source.width,
    sourceHeight: project.source.height,
    sourceFps: project.source.fps,
    hasAudio: project.source.hasAudio,
    trim: project.trim,
    crop: project.crop,
    framing: project.framing,
    zoom: { enabled: project.zoom.enabled, keyframes: project.zoom.keyframes },
    cursor: {
      enabled: cursorEnabled && !!cursorOverlayPath,
      track: cursorTrack,
    },
    cursorStyle: project.cursorStyle,
    callouts,
    presetId: preset.id,
    outputPath: videoPath,
    cursorOverlayPath,
    ...(cornerMaskPath ? { cornerMaskPath } : {}),
    ...(request.fontFile ? { fontFile: request.fontFile } : {}),
  };

  const renderJob = buildRenderArgs(plan);
  const jobs: string[][] = [renderJob];
  const renderResult = await ports.run(renderJob);
  if (renderResult.code !== 0) {
    throw new ProcessError("ffmpeg", renderResult.code, renderResult.stderr);
  }

  // --- poster frame (best effort) ---------------------------------------------
  let poster: string | null = posterPath;
  const posterJob = buildPosterArgs(
    videoPath,
    choosePosterTime(normalized, request.posterAtMs),
    posterPath,
  );
  jobs.push(posterJob);
  const posterResult = await ports.run(posterJob);
  if (posterResult.code !== 0) {
    warnings.push(`Poster frame generation failed: ${lastLines(posterResult.stderr, 2)}`);
    poster = null;
  }

  // --- transcript --------------------------------------------------------------
  const transcript = await ports.transcript.transcribe({
    audioPath: videoPath,
    startMs: 0,
    endMs: normalized.durationMs,
    hasAudio: project.source.hasAudio,
  });

  let transcriptPath: string | null = null;
  if (transcript.available) {
    await ports.writeText(transcriptTxtPath, `${transcriptToPlainText(transcript)}\n`);
    await ports.writeText(transcriptJsonPath, `${JSON.stringify(transcript, null, 2)}\n`);
    transcriptPath = transcriptTxtPath;
  }

  // --- markdown summary --------------------------------------------------------
  const stat = await ports.stat(videoPath);
  const artifact: ExportArtifact = {
    id: ports.id(),
    createdAt: ports.now(),
    presetId: preset.id,
    videoPath,
    posterPath: poster,
    transcriptPath,
    summaryPath,
    bytes: stat.size,
    durationMs: normalized.durationMs,
  };

  const summaryMarkdown = buildSummaryMarkdown({ project, artifact, transcript });
  await ports.writeText(summaryPath, summaryMarkdown);

  return { artifact, transcript, summaryMarkdown, jobs, warnings };
}

/** Human-readable list of the files an export produced (for the success UI). */
export function exportArtifacts(artifact: ExportArtifact): Array<{ label: string; path: string }> {
  const items: Array<{ label: string; path: string }> = [
    { label: "Video", path: artifact.videoPath },
  ];
  if (artifact.posterPath) items.push({ label: "Poster", path: artifact.posterPath });
  if (artifact.transcriptPath) items.push({ label: "Transcript", path: artifact.transcriptPath });
  if (artifact.summaryPath) items.push({ label: "Summary", path: artifact.summaryPath });
  return items;
}

export type { Project };
