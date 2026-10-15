import type { Transcript } from "./types.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TranscribeRequest {
  /** Path to the media to transcribe (usually the trimmed export). */
  audioPath: string;
  startMs: number;
  endMs: number;
  hasAudio: boolean;
}

export interface Transcriber {
  available(): Promise<boolean>;
  transcribe(request: TranscribeRequest): Promise<Transcript>;
}

export interface FileMetadata {
  size: number;
}

/**
 * Environment ports the media pipeline depends on. The Tauri app supplies a
 * Rust-backed implementation; tests supply a Node implementation. Nothing in
 * `pipeline.ts` touches the OS directly, which keeps it deterministic and
 * easy to test.
 */
export interface MediaPorts {
  /** Runs a process (ffmpeg/ffprobe). `argv[0]` is the tool name. */
  run(argv: string[]): Promise<ProcessResult>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileMetadata>;
  mkdirp(path: string): Promise<void>;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  transcript: Transcriber;
  now(): number;
  id(): string;
}

export class ProcessError extends Error {
  constructor(
    readonly tool: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`${tool} exited with code ${code}: ${lastLines(stderr, 4)}`);
    this.name = "ProcessError";
  }
}

export function lastLines(text: string, count: number): string {
  const lines = text.trim().split(/\r?\n/);
  return lines.slice(-count).join(" | ");
}

/** Returns an available path in `dir` by appending `-2`, `-3`, ... as needed. */
export async function resolveUniqueStem(
  dir: string,
  stem: string,
  extension: string,
  ports: Pick<MediaPorts, "exists" | "join">,
): Promise<string> {
  let candidate = stem;
  let index = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const path = ports.join(dir, `${candidate}.${extension}`);
    // eslint-disable-next-line no-await-in-loop
    if (!(await ports.exists(path))) return candidate;
    candidate = `${stem}-${index}`;
    index += 1;
  }
}
