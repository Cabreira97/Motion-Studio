import { describe, expect, it } from "vitest";
import { formatBytes, buildSummaryMarkdown } from "../src/core/markdown.js";
import { StaticTranscriber } from "../src/core/transcript.js";
import { addZoomStop, createProject, withZoomMode } from "../src/core/project.js";
import type { ExportArtifact } from "../src/core/types.js";

function sampleProject() {
  return createProject({
    id: "p1",
    name: "Demo Recording",
    captureKind: "screen",
    sourceLabel: "Display 1",
    mic: true,
    source: {
      path: "/tmp/in.mp4",
      width: 1920,
      height: 1080,
      durationMs: 5000,
      fps: 30,
      hasAudio: true,
    },
    now: 1_700_000_000_000,
  });
}

const artifact: ExportArtifact = {
  id: "a1",
  createdAt: 1_700_000_100_000,
  presetId: "mp4-1080p",
  videoPath: "/tmp/out/Demo Recording.mp4",
  posterPath: "/tmp/out/Demo Recording.poster.jpg",
  transcriptPath: "/tmp/out/Demo Recording.transcript.txt",
  summaryPath: "/tmp/out/Demo Recording.md",
  bytes: 2048,
  durationMs: 5000,
};

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildSummaryMarkdown", () => {
  it("includes metadata, files, edit settings and transcript", async () => {
    const project = sampleProject();
    const transcript = await new StaticTranscriber([
      { startMs: 0, endMs: 1000, text: "Hello there." },
      { startMs: 1000, endMs: 2000, text: "This is local." },
    ]).transcribe({ audioPath: "", startMs: 0, endMs: 2000, hasAudio: true });

    const md = buildSummaryMarkdown({ project, artifact, transcript, generatedAt: 1_700_000_200_000 });
    expect(md).toContain("# Demo Recording");
    expect(md).toContain("**Capture:** screen");
    expect(md).toContain("## Files");
    expect(md).toContain("Demo Recording.mp4");
    expect(md).toContain("## Edit");
    expect(md).toContain("## Transcript");
    expect(md).toContain("Hello there. This is local.");
  });

  it("explains when the transcript is unavailable", () => {
    const project = sampleProject();
    const md = buildSummaryMarkdown({
      project,
      artifact,
      transcript: { available: false, reason: "no recognizer", segments: [], text: "" },
    });
    expect(md).toContain("Transcript unavailable");
    expect(md).toContain("WHISPER_CPP_BIN");
  });

  it("names the zoom source so the summary matches what was rendered", () => {
    const transcript = { available: false, segments: [], text: "" };
    const auto = buildSummaryMarkdown({ project: sampleProject(), artifact, transcript });
    expect(auto).toContain("- Zoom: cursor,");

    const manual = buildSummaryMarkdown({
      project: addZoomStop(withZoomMode(sampleProject(), "manual"), { id: "s1", t: 1000 }),
      artifact,
      transcript,
    });
    expect(manual).toContain("- Zoom: manual,");
  });

  it("lists callouts when present", () => {
    const project = sampleProject();
    project.callouts = [
      {
        id: "c1",
        t: 1000,
        durationMs: 1500,
        x: 0.5,
        y: 0.5,
        text: "Click here",
        fontSize: 32,
        color: "#ffffff",
        boxColor: "#000000@0.8",
      },
    ];
    const md = buildSummaryMarkdown({
      project,
      artifact,
      transcript: { available: false, segments: [], text: "" },
    });
    expect(md).toContain("## Callouts");
    expect(md).toContain("Click here");
  });
});
