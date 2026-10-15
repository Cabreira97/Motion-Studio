import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Locates ffmpeg/ffprobe without assuming they are on PATH (Windows sessions
 * often need a shell restart after install). Resolution order:
 *   1. explicit env override (FFMPEG_PATH / FFPROBE_PATH)
 *   2. the system PATH
 *   3. known winget / package-manager install locations
 */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const packages = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    dirs.push(...scanForBinDir(packages));
  }
  if (process.env.ProgramFiles) {
    dirs.push(path.join(process.env.ProgramFiles, "ffmpeg", "bin"));
  }
  dirs.push("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin");
  return dirs;
}

function scanForBinDir(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.toLowerCase().includes("ffmpeg")) continue;
      const base = path.join(root, entry);
      for (const child of safelyReadDir(base)) {
        const bin = path.join(base, child, "bin");
        if (existsSync(bin)) result.push(bin);
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

function safelyReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function findOnPath(tool: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, tool + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveTool(envKey: string, tool: string): string | null {
  const override = process.env[envKey];
  if (override && existsSync(override)) return override;
  const onPath = findOnPath(tool);
  if (onPath) return onPath;
  for (const dir of candidateDirs()) {
    for (const ext of ["", ".exe"]) {
      const candidate = path.join(dir, tool + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveFfmpeg(): string | null {
  return resolveTool("FFMPEG_PATH", "ffmpeg");
}

export function resolveFfprobe(): string | null {
  return resolveTool("FFPROBE_PATH", "ffprobe");
}

/** Throws a helpful error if ffmpeg is not installed. */
export function requireFfmpeg(): string {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg was not found. Install it (e.g. `winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg`) or set FFMPEG_PATH in your .env.",
    );
  }
  return ffmpeg;
}

export function ffmpegAvailable(): boolean {
  return resolveFfmpeg() !== null;
}
