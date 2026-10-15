import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireFfmpeg, resolveFfprobe } from "../../src/platform/ffmpegPath.js";

export function makeTempDir(prefix = "motion-studio-test-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function ffprobeSync(args: string[]) {
  const ffprobe = resolveFfprobe();
  if (!ffprobe) throw new Error("ffprobe not found");
  return spawnSync(ffprobe, args, { encoding: "utf8", windowsHide: true });
}

export interface ProbeResult {
  format: { duration: string; size: string; format_name: string };
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
}

export function probe(filePath: string): ProbeResult {
  const result = ffprobeSync([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ProbeResult;
}

/** Generates a short deterministic source clip with a video and audio track. */
export function makeSourceVideo(
  outputPath: string,
  options: { seconds?: number; width?: number; height?: number; fps?: number; withAudio?: boolean } = {},
): string {
  const seconds = options.seconds ?? 3;
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const fps = options.fps ?? 30;
  const withAudio = options.withAudio ?? true;
  const ffmpeg = requireFfmpeg();

  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=duration=${seconds}:size=${width}x${height}:rate=${fps}`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
  );
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(outputPath);

  const result = spawnSync(ffmpeg, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`failed to generate source video: ${result.stderr}`);
  }
  return outputPath;
}

/** Finds a usable TrueType font for ffmpeg drawtext on this machine. */
export function findFont(): string | undefined {
  const candidates = [
    process.env.FFMPEG_FONT,
    process.platform === "win32" ? "C:/Windows/Fonts/arial.ttf" : undefined,
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ].filter((x): x is string => typeof x === "string");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
