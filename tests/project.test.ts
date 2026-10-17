import { describe, expect, it } from "vitest";
import {
  addExport,
  createProject,
  deriveFraming,
  summarizeTrim,
  timestampName,
  withCrop,
  withPreset,
  withExportDriveUrl,
  withTrim,
} from "../src/core/project.js";
import type { ExportArtifact, SourceMedia } from "../src/core/types.js";

const source: SourceMedia = {
  path: "/tmp/in.mp4",
  width: 1600,
  height: 1000,
  durationMs: 8000,
  fps: 30,
  hasAudio: true,
};

function make() {
  return createProject({
    id: "p1",
    name: "Test",
    captureKind: "screen",
    mic: true,
    source,
    now: 1_700_000_000_000,
    cursorTrack: [
      { t: 500, x: 0.2, y: 0.2 },
      { t: 700, x: 0.25, y: 0.2 },
      { t: 900, x: 0.3, y: 0.25 },
    ],
  });
}

describe("deriveFraming", () => {
  it("matches the source aspect ratio with even dimensions", () => {
    const framing = deriveFraming(source, "mp4-1080p");
    expect(framing.outputWidth % 2).toBe(0);
    expect(framing.outputHeight % 2).toBe(0);
    const aspect = framing.outputWidth / framing.outputHeight;
    expect(Math.abs(aspect - source.width / source.height)).toBeLessThan(0.02);
  });
});

describe("createProject", () => {
  it("seeds a full-length trim and auto zoom keyframes", () => {
    const project = make();
    expect(project.trim.startMs).toBe(0);
    expect(project.trim.endMs).toBe(8000);
    expect(project.zoom.enabled).toBe(true);
    expect(project.zoom.keyframes.length).toBeGreaterThan(2);
    expect(project.cursorTrack).toHaveLength(3);
  });

  it("uses a timestamped default name when none is provided", () => {
    const project = createProject({
      id: "p2",
      captureKind: "region",
      mic: false,
      source,
      now: 0,
    });
    expect(project.name).toMatch(/Recording/);
  });
});

describe("project mutations", () => {
  it("clamps crops non-destructively", () => {
    const project = withCrop(make(), { x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
    expect(project.crop.x + project.crop.width).toBeLessThanOrEqual(1.0001);
    expect(project.source?.path).toBe("/tmp/in.mp4");
  });

  it("recomputes zoom when trimming", () => {
    const project = withTrim(make(), { startMs: 400, endMs: 1200 });
    expect(project.trim.startMs).toBeLessThanOrEqual(400 + 40);
    expect(project.zoom.keyframes.length).toBeGreaterThan(0);
  });

  it("swaps resolution when the preset changes", () => {
    const project = withPreset(make(), "mp4-720p");
    expect(project.export.presetId).toBe("mp4-720p");
    expect(project.framing.outputHeight).toBeLessThanOrEqual(720);
  });

  it("prepends export artifacts", () => {
    const artifact: ExportArtifact = {
      id: "a",
      createdAt: 1,
      presetId: "mp4-1080p",
      videoPath: "/tmp/out.mp4",
      posterPath: null,
      transcriptPath: null,
      summaryPath: null,
      bytes: 1,
      durationMs: 1,
    };
    const project = addExport(make(), artifact);
    expect(project.exports[0]!.id).toBe("a");
  });

  it("records the Drive link on a single export", () => {
    const base: ExportArtifact = {
      id: "a",
      createdAt: 1,
      presetId: "mp4-1080p",
      videoPath: "/tmp/a.mp4",
      posterPath: null,
      transcriptPath: null,
      summaryPath: null,
      bytes: 1,
      durationMs: 1,
    };
    const project = addExport(addExport(make(), base), { ...base, id: "b", videoPath: "/tmp/b.mp4" });
    const next = withExportDriveUrl(project, "a", "https://drive.google.com/file/d/x/view");
    expect(next.exports.find((e) => e.id === "a")!.driveUrl).toBe("https://drive.google.com/file/d/x/view");
    expect(next.exports.find((e) => e.id === "b")!.driveUrl).toBeUndefined();
    expect(project.exports.find((e) => e.id === "a")!.driveUrl).toBeUndefined();
  });
});

describe("helpers", () => {
  it("formats a timestamp name", () => {
    expect(timestampName("Recording", Date.UTC(2026, 0, 2, 3, 4, 5))).toMatch(/^Recording \d{4}-\d{2}-\d{2}/);
  });

  it("summarizes the trim", () => {
    expect(summarizeTrim(make())).toContain("→");
  });
});
