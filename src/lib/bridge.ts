/**
 * Thin bridge to the Rust/Tauri layer.
 *
 * The same UI must also run in a plain browser (`pnpm dev`) for quick UI work,
 * so every call degrades to a clear, recoverable error when Tauri is absent
 * rather than throwing at import time.
 */

import type { MediaPorts, Transcriber, TranscribeRequest } from "../core/ports.js";
import type { Project, Transcript } from "../core/types.js";

export class BridgeUnavailableError extends Error {
  constructor(what: string) {
    super(
      `${what} requires the desktop app. Run \`pnpm first-run\` (or \`pnpm tauri dev\`) instead of the browser dev server.`,
    );
    this.name = "BridgeUnavailableError";
  }
}

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      "undefined"
  );
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new BridgeUnavailableError(`"${command}"`);
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// Types mirrored from the Rust commands
// ---------------------------------------------------------------------------

export interface AppInfo {
  appDataDir: string;
  recordingsDir: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  cursorSampling: boolean;
  whisperAvailable: boolean;
}

export interface SavedFile {
  path: string;
  bytes: number;
}

export interface SessionState {
  running: boolean;
  elapsedMs: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  data: string;
}

export interface CaptureCapabilities {
  screen: boolean;
  window: boolean;
  region: boolean;
  microphone: boolean;
  cursorSampling: boolean;
  /** Why cursor sampling is unavailable, when it is (Wayland, no DISPLAY, …). */
  cursorNote: string | null;
  backend: string;
}

export interface ProcessOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Result of probing a media file (mirrors the Rust `MediaInfo`). */
export interface MediaInfo {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

// ---------------------------------------------------------------------------
// High-level wrappers
// ---------------------------------------------------------------------------

export const bridge = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  captureCapabilities: () => invoke<CaptureCapabilities>("capture_capabilities"),
  probeMedia: (path: string) => invoke<MediaInfo>("probe_media", { path }),
  runFfmpeg: (args: string[]) => invoke<ProcessOutput>("run_ffmpeg", { args }),
  resolveRecordingPath: (name: string) =>
    invoke<string>("resolve_recording_path", { name }),
  saveRecording: (name: string, data: Uint8Array) =>
    invoke<SavedFile>("save_recording", { name, data: Array.from(data) }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  writeBinaryFile: (path: string, data: Uint8Array) =>
    invoke<SavedFile>("write_binary_file", { path, data: Array.from(data) }),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  fileSize: (path: string) => invoke<number>("file_size", { path }),
  ensureDir: (path: string) => invoke<void>("ensure_dir", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  copyPath: (text: string) => invoke<void>("copy_path", { text }),
  findSystemFont: () => invoke<string | null>("find_system_font"),
  sessionStart: () => invoke<SessionState>("session_start"),
  sessionStop: () => invoke<SessionState>("session_stop"),
  sessionState: () => invoke<SessionState>("session_state"),
  cursorStart: (intervalMs?: number) =>
    invoke<void>("cursor_start", { intervalMs: intervalMs ?? null }),
  cursorStop: () => invoke<Array<{ t: number; x: number; y: number }>>("cursor_stop"),
  listProjects: () => invoke<ProjectRow[]>("list_projects"),
  getProject: (id: string) => invoke<ProjectRow | null>("get_project", { id }),
  saveProject: (project: Project) =>
    invoke<void>("save_project", {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      data: JSON.stringify(project),
    }),
  deleteProject: (id: string) => invoke<boolean>("delete_project", { id }),
  transcribe: (audioPath: string, hasAudio: boolean) =>
    invoke<RustTranscript>("transcribe", { audioPath, hasAudio }),
};

interface RustTranscript {
  available: boolean;
  reason?: string | null;
  language?: string | null;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  text: string;
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  const unlisten = await tauriListen<T>(event, (e) => handler(e.payload));
  return unlisten;
}

/**
 * Converts a local file path into a URL the webview can load. Falls back to the
 * path unchanged in the browser where there is no asset protocol.
 */
export async function toAssetUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

// ---------------------------------------------------------------------------
// MediaPorts + Transcriber backed by the Rust layer
// ---------------------------------------------------------------------------

const path = {
  join: (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
  dirname: (p: string) => p.replace(/\\/g, "/").split("/").slice(0, -1).join("/"),
  basename: (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p,
};

class TauriTranscriber implements Transcriber {
  async available(): Promise<boolean> {
    const info = await bridge.getAppInfo();
    return info.whisperAvailable;
  }

  async transcribe(request: TranscribeRequest): Promise<Transcript> {
    const result = await bridge.transcribe(request.audioPath, request.hasAudio);
    return {
      available: result.available,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.language ? { language: result.language } : {}),
      segments: result.segments,
      text: result.text,
    };
  }
}

/** MediaPorts implemented against the Rust backend. */
export function createTauriPorts(): MediaPorts {
  return {
    run: (argv) => bridge.runFfmpeg(argv),
    writeText: (p, content) => bridge.writeTextFile(p, content),
    writeBinary: async (p, data) => {
      await bridge.writeBinaryFile(p, data);
    },
    exists: (p) => bridge.fileExists(p),
    stat: async (p) => ({ size: await bridge.fileSize(p) }),
    mkdirp: (p) => bridge.ensureDir(p),
    join: path.join,
    dirname: path.dirname,
    basename: path.basename,
    transcript: new TauriTranscriber(),
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
  };
}
