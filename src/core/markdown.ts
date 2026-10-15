import { formatDuration } from "./time.js";
import type { ExportArtifact, Project, Transcript } from "./types.js";

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export interface SummaryOptions {
  project: Project;
  artifact: ExportArtifact;
  transcript: Transcript;
  generatedAt?: number;
}

/**
 * Produces a human-readable Markdown summary that is written next to each
 * exported video (alongside the poster and transcript). It intentionally
 * contains only local paths — there is no cloud or sharing link.
 */
export function buildSummaryMarkdown(options: SummaryOptions): string {
  const { project, artifact, transcript } = options;
  const generatedAt = options.generatedAt ?? Date.now();
  const lines: string[] = [];

  lines.push(`# ${project.name}`);
  lines.push("");
  lines.push(`> Auto-generated summary for a Frame Studio export.`);
  lines.push("");
  lines.push(`- **Generated:** ${new Date(generatedAt).toISOString()}`);
  lines.push(`- **Capture:** ${project.capture.kind}${project.capture.sourceLabel ? ` — ${project.capture.sourceLabel}` : ""}`);
  lines.push(`- **Microphone:** ${project.capture.mic ? "yes" : "no"}`);
  lines.push(`- **Preset:** ${artifact.presetId}`);
  lines.push(`- **Duration:** ${formatDuration(artifact.durationMs)}`);
  lines.push(`- **File size:** ${formatBytes(artifact.bytes)}`);
  lines.push("");

  lines.push("## Files");
  lines.push("");
  lines.push(`- Video: \`${artifact.videoPath}\``);
  if (artifact.posterPath) lines.push(`- Poster: \`${artifact.posterPath}\``);
  if (artifact.transcriptPath) lines.push(`- Transcript: \`${artifact.transcriptPath}\``);
  lines.push("");

  if (project.source) {
    lines.push("## Source");
    lines.push("");
    lines.push(
      `- ${project.source.width}×${project.source.height} @ ${project.source.fps}fps`,
    );
    lines.push(`- Raw recording: \`${project.source.path}\``);
    lines.push("");
  }

  lines.push("## Edit");
  lines.push("");
  lines.push(
    `- Trim: ${formatDuration(project.trim.startMs)} → ${formatDuration(project.trim.endMs)}`,
  );
  lines.push(
    `- Crop: x=${project.crop.x.toFixed(3)}, y=${project.crop.y.toFixed(3)}, w=${project.crop.width.toFixed(3)}, h=${project.crop.height.toFixed(3)}`,
  );
  lines.push(`- Auto zoom: ${project.zoom.enabled ? `${project.zoom.keyframes.length} keyframes` : "off"}`);
  lines.push(
    `- Cursor: ${project.cursorStyle.highlight ? "highlight on" : "highlight off"}${project.cursorStyle.zoomFollow ? ", follows cursor" : ""}`,
  );
  lines.push(
    `- Framing: padding ${project.framing.paddingPx}px, background ${project.framing.background}, ${project.framing.outputWidth}×${project.framing.outputHeight}`,
  );
  lines.push("");

  if (project.callouts.length > 0) {
    lines.push("## Callouts");
    lines.push("");
    for (const callout of project.callouts) {
      lines.push(`- [${formatDuration(callout.t)}] ${callout.text}`);
    }
    lines.push("");
  }

  lines.push("## Transcript");
  lines.push("");
  if (!transcript.available) {
    lines.push(
      `_Transcript unavailable: ${transcript.reason ?? "no speech recognizer configured"}._`,
    );
    lines.push("");
    lines.push(
      "Configure `WHISPER_CPP_BIN` and `WHISPER_MODEL` in your `.env` to enable local transcripts.",
    );
  } else if (transcript.text.trim().length === 0) {
    lines.push("_No speech detected._");
  } else {
    lines.push(transcript.text.trim());
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(
    `_Poster frame: ${artifact.posterPath ? basename(artifact.posterPath) : "not generated"}. Everything stays on this machine._`,
  );

  return `${lines.join("\n")}\n`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
