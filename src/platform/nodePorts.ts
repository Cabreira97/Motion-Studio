import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { requireFfmpeg, resolveFfprobe } from "./ffmpegPath.js";
import type { MediaPorts, ProcessResult, Transcriber } from "../core/ports.js";
import { UnavailableTranscriber } from "../core/transcript.js";

export interface NodePortsOptions {
  transcript?: Transcriber;
  /** Override process spawner (mainly for tests). */
  spawnFn?: SpawnLike;
}

type SpawnLike = (
  command: string,
  args: string[],
) => Promise<ProcessResult>;

async function defaultSpawn(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Node implementation of {@link MediaPorts}. Used by the test-suite and by the
 * headless `pnpm export` CLI so the exact same pipeline that runs in the app
 * can be exercised from the terminal.
 */
export function createNodePorts(options: NodePortsOptions = {}): MediaPorts {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const transcript = options.transcript ?? new UnavailableTranscriber();

  return {
    async run(argv: string[]): Promise<ProcessResult> {
      const [tool, ...rest] = argv;
      let command: string;
      if (!tool || tool === "ffmpeg") command = requireFfmpeg();
      else if (tool === "ffprobe") {
        const probe = resolveFfprobe();
        if (!probe) throw new Error("ffprobe was not found. Set FFPROBE_PATH or install ffmpeg.");
        command = probe;
      } else {
        throw new Error(`Refusing to run unexpected tool: ${tool}`);
      }
      return spawnFn(command, rest);
    },
    async writeText(filePath, content) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    },
    async writeBinary(filePath, data) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, Buffer.from(data));
    },
    async exists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async stat(filePath) {
      const info = await fs.stat(filePath);
      return { size: info.size };
    },
    async mkdirp(dir) {
      await fs.mkdir(dir, { recursive: true });
    },
    join: (...parts) => path.join(...parts),
    dirname: (p) => path.dirname(p),
    basename: (p) => path.basename(p),
    transcript,
    now: () => Date.now(),
    id: () => randomUUID(),
  };
}
