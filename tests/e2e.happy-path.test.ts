import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject } from "../src/core/project.js";
import { runExport } from "../src/core/pipeline.js";
import { StaticTranscriber } from "../src/core/transcript.js";
import { createNodePorts } from "../src/platform/nodePorts.js";
import { ffmpegAvailable } from "../src/platform/ffmpegPath.js";
import { DEFAULT_CURSOR_STYLE } from "../src/core/types.js";
import {
  cleanup,
  findFont,
  makeSourceVideo,
  makeTempDir,
  probe,
  readText,
} from "./helpers/ffmpeg.js";

const describeIfFfmpeg = ffmpegAvailable() ? describe : describe.skip;

describeIfFfmpeg("end-to-end happy path (local ffmpeg)", () => {
  let workDir: string;
  let sourcePath: string;
  const font = findFont();

  beforeAll(() => {
    workDir = makeTempDir();
    sourcePath = makeSourceVideo(path.join(workDir, "raw capture.mp4"), {
      seconds: 3,
      width: 640,
      height: 360,
      fps: 30,
      withAudio: true,
    });
  });

  afterAll(() => {
    cleanup(workDir);
  });

  it("records -> auto-zooms -> trims -> exports an MP4 with poster, transcript and summary", async () => {
    const outputDir = path.join(workDir, "exports");
    const sourceStat = statSync(sourcePath);
    const probed = probe(sourcePath);
    const durationMs = Math.round(Number(probed.format.duration) * 1000);
    const videoStream = probed.streams.find((s) => s.codec_type === "video")!;
    const hasAudio = probed.streams.some((s) => s.codec_type === "audio");

    // Simulate a cursor moving across the frame during the recording.
    const cursorTrack = Array.from({ length: 30 }, (_, i) => ({
      t: 700 + i * 30,
      x: 0.3 + Math.sin(i / 4) * 0.1,
      y: 0.4 + Math.cos(i / 4) * 0.1,
    }));

    const project = createProject({
      id: "e2e-1",
      name: "E2E Demo",
      captureKind: "screen",
      sourceLabel: "Display 1",
      mic: true,
      source: {
        path: sourcePath,
        width: videoStream.width!,
        height: videoStream.height!,
        durationMs,
        fps: 30,
        hasAudio,
      },
      cursorTrack,
    });
    project.trim = { startMs: 500, endMs: Math.min(2500, durationMs) };
    project.cursorStyle = { ...DEFAULT_CURSOR_STYLE, highlight: true };
    if (font) {
      project.callouts = [
        {
          id: "c1",
          t: 300,
          durationMs: 1200,
          x: 0.5,
          y: 0.75,
          text: "Recorded locally",
          fontSize: 40,
          color: "#ffffff",
          boxColor: "#111827@0.85",
        },
      ];
    }

    const ports = createNodePorts({
      transcript: new StaticTranscriber(
        [{ startMs: 0, endMs: 1200, text: "This is a local recording." }],
        "en",
      ),
    });

    const result = await runExport(
      { project, outputDir, ...(font ? { fontFile: font } : {}) },
      ports,
    );

    // Job plan was produced and executed.
    expect(result.jobs.length).toBeGreaterThanOrEqual(2);

    // Video exists, non-trivial and decodes as H.264 with the trimmed duration.
    expect(existsSync(result.artifact.videoPath)).toBe(true);
    expect(result.artifact.bytes).toBeGreaterThan(1000);
    const exported = probe(result.artifact.videoPath);
    const outVideo = exported.streams.find((s) => s.codec_type === "video")!;
    expect(outVideo.codec_name).toBe("h264");
    expect(Number(exported.format.duration)).toBeGreaterThan(1.5);
    expect(Number(exported.format.duration)).toBeLessThan(2.6);

    // Poster + transcript + summary written beside the video.
    expect(result.artifact.posterPath).toBeTruthy();
    expect(existsSync(result.artifact.posterPath!)).toBe(true);
    expect(result.artifact.transcriptPath).toBeTruthy();
    expect(existsSync(result.artifact.transcriptPath!)).toBe(true);
    expect(existsSync(result.artifact.summaryPath!)).toBe(true);

    const summary = readText(result.artifact.summaryPath!);
    expect(summary).toContain("# E2E Demo");
    expect(summary).toContain("## Files");
    expect(summary).toContain("## Transcript");
    expect(summary).toContain("This is a local recording.");
    if (font) {
      expect(summary).toContain("Recorded locally");
    }

    const transcriptTxt = readText(result.artifact.transcriptPath!);
    expect(transcriptTxt).toContain("This is a local recording.");

    // The raw recording is never modified (non-destructive editing).
    expect(statSync(sourcePath).size).toBe(sourceStat.size);

    // The poster is a real JPEG (decodes and is small).
    const poster = readFileSync(result.artifact.posterPath!);
    expect(poster[0]).toBe(0xff);
    expect(poster[1]).toBe(0xd8);
  }, 120_000);

  it("exports a WebM (VP9) preset through the same pipeline", async () => {
    const outputDir = path.join(workDir, "exports-webm");
    const probed = probe(sourcePath);
    const durationMs = Math.round(Number(probed.format.duration) * 1000);
    const videoStream = probed.streams.find((s) => s.codec_type === "video")!;

    const project = createProject({
      id: "e2e-2",
      name: "WebM Demo",
      captureKind: "region",
      mic: false,
      presetId: "webm-vp9-720p",
      source: {
        path: sourcePath,
        width: videoStream.width!,
        height: videoStream.height!,
        durationMs,
        fps: 30,
        hasAudio: true,
      },
      cursorTrack: [],
    });
    project.trim = { startMs: 300, endMs: 1500 };
    project.zoom.enabled = false;
    project.cursorStyle.highlight = false;

    const ports = createNodePorts();
    const result = await runExport({ project, outputDir }, ports);

    expect(result.artifact.videoPath.endsWith(".webm")).toBe(true);
    const exported = probe(result.artifact.videoPath);
    const outVideo = exported.streams.find((s) => s.codec_type === "video")!;
    expect(outVideo.codec_name).toBe("vp9");
    expect(Number(exported.format.duration)).toBeGreaterThan(0.8);
  }, 120_000);
});
