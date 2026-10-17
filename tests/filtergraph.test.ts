import { describe, expect, it } from "vitest";
import {
  buildProbeArgs,
  buildRenderArgs,
  buildZoomExpression,
  choosePosterTime,
  clampTextBox,
  computeCropPixels,
  computeStageLayout,
  escapeDrawtext,
  escapeFilterPath,
  buildGraph,
  fitInside,
  zoomWindow,
  type RenderPlan,
} from "../src/core/filtergraph.js";
import { getPreset, presetCodecArgs, resolveOutputSize, EXPORT_PRESETS } from "../src/core/presets.js";
import { DEFAULT_FRAMING } from "../src/core/types.js";

function plan(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return {
    sourcePath: "/tmp/in.mp4",
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceFps: 30,
    hasAudio: true,
    trim: { startMs: 0, endMs: 2000 },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    framing: { ...DEFAULT_FRAMING },
    zoom: { enabled: true, keyframes: [] },
    cursor: { enabled: false, track: [] },
    cursorStyle: { highlight: false, radiusScale: 0.06, smoothingMs: 450, zoomFollow: true },
    callouts: [],
    presetId: "mp4-1080p",
    outputPath: "/tmp/out.mp4",
    ...overrides,
  };
}

describe("escapers", () => {
  it("escapes drawtext special characters", () => {
    expect(escapeDrawtext("a:b'c%d")).toBe("a\\:b\\'c\\%d");
    expect(escapeDrawtext("line1\nline2")).toBe("line1\\nline2");
  });

  it("escapes filter paths for cross-platform use", () => {
    expect(escapeFilterPath("C:\\Windows\\Fonts\\a.ttf")).toBe("C\\:/Windows/Fonts/a.ttf");
  });
});

describe("computeCropPixels", () => {
  it("returns even dimensions inside the source", () => {
    const pixels = computeCropPixels(1920, 1080, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(pixels.width % 2).toBe(0);
    expect(pixels.height % 2).toBe(0);
    expect(pixels.x + pixels.width).toBeLessThanOrEqual(1920);
    expect(pixels.y + pixels.height).toBeLessThanOrEqual(1080);
  });

  it("clamps out-of-range rects", () => {
    const pixels = computeCropPixels(1000, 500, { x: 2, y: -1, width: 2, height: 2 });
    expect(pixels.width).toBeLessThanOrEqual(1000);
    expect(pixels.x).toBeGreaterThanOrEqual(0);
  });
});

describe("fitInside", () => {
  it("keeps the source aspect ratio and returns even sizes", () => {
    const fitted = fitInside(1920, 1080, 1792, 1008);
    expect(fitted).toEqual({ width: 1792, height: 1008 });
  });

  it("fits a portrait source inside a landscape box", () => {
    const fitted = fitInside(1080, 1920, 1792, 1008);
    expect(fitted.height).toBeLessThanOrEqual(1008);
    expect(fitted.width).toBeLessThanOrEqual(1792);
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);
    // 1080/1920 = 0.5625 aspect kept within a pixel of rounding.
    expect(fitted.width / fitted.height).toBeCloseTo(1080 / 1920, 2);
  });

  it("never exceeds the box and degrades safely on bad input", () => {
    const fitted = fitInside(0, 0, 100, 50);
    expect(fitted.width).toBeGreaterThan(0);
    expect(fitted.height).toBeGreaterThan(0);
  });
});

describe("buildZoomExpression", () => {
  const keyframes = [
    { t: 0, scale: 1, cx: 0.5, cy: 0.5 },
    { t: 1000, scale: 2, cx: 0.2, cy: 0.3 },
    { t: 2000, scale: 1, cx: 0.5, cy: 0.5 },
  ];

  it("produces a balanced expression", () => {
    const expr = buildZoomExpression(keyframes, "scale");
    const open = (expr.match(/if\(/g) ?? []).length;
    expect(open).toBeGreaterThan(0);
    // No unbalanced parentheses anywhere in the expression.
    let depth = 0;
    for (const ch of expr) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("uses the provided time variable", () => {
    const expr = buildZoomExpression(keyframes, "cx", "(on/30)");
    expect(expr).toContain("(on/30)");
    expect(expr).not.toMatch(/lt\(t,/);
  });

  it("returns a constant for a single keyframe", () => {
    expect(buildZoomExpression([{ t: 0, scale: 1.5, cx: 0.1, cy: 0.1 }], "scale")).toBe("1.5");
  });
});

describe("presets", () => {
  it("exposes both H.264 and WebM presets", () => {
    const ids = EXPORT_PRESETS.map((p) => p.id);
    expect(ids).toContain("mp4-1080p");
    expect(ids).toContain("webm-vp9");
  });

  it("maps presets to codec arguments", () => {
    const mp4 = getPreset("mp4-1080p");
    const args = presetCodecArgs(mp4, true);
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("-movflags");

    const webm = getPreset("webm-vp9");
    const webmArgs = presetCodecArgs(webm, true);
    expect(webmArgs).toContain("libvpx-vp9");
    expect(webmArgs).toContain("libopus");
  });

  it("disables audio when there is no audio track", () => {
    expect(presetCodecArgs(getPreset("mp4-1080p"), false)).toContain("-an");
  });

  it("resolves even output sizes capped by the preset", () => {
    const size = resolveOutputSize(
      { ...DEFAULT_FRAMING, outputWidth: 1920, outputHeight: 1080 },
      getPreset("mp4-720p"),
    );
    expect(size).toEqual({ width: 1280, height: 720 });
  });
});

describe("buildGraph", () => {
  it("produces a valid-looking graph with trim, fps and output format", () => {
    const graph = buildGraph(plan());
    expect(graph.filterComplex).toContain("trim=start=0");
    expect(graph.filterComplex).toContain("fps=30");
    expect(graph.filterComplex).toContain("pad=1920:1080");
    expect(graph.filterComplex).toContain("format=yuv420p[vout]");
    expect(graph.videoMap).toBe("[vout]");
    expect(graph.audioMap).toBe("[aout]");
  });

  it("omits the audio map when there is no audio", () => {
    const graph = buildGraph(plan({ hasAudio: false }));
    expect(graph.audioMap).toBeNull();
    expect(graph.filterComplex).not.toContain("atrim");
  });

  it("adds a crop only when cropping", () => {
    expect(buildGraph(plan()).filterComplex).not.toContain("crop=");
    const cropped = buildGraph(plan({ crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }));
    expect(cropped.filterComplex).toContain("crop=");
  });

  it("adds zoompan when zoom is enabled with keyframes", () => {
    const graph = buildGraph(
      plan({
        zoom: {
          enabled: true,
          keyframes: [
            { t: 0, scale: 1, cx: 0.5, cy: 0.5 },
            { t: 1000, scale: 2, cx: 0.3, cy: 0.3 },
          ],
        },
      }),
    );
    expect(graph.filterComplex).toContain("zoompan=");
  });

  it("adds a second input and overlay for the cursor highlight", () => {
    const graph = buildGraph(
      plan({
        cursorOverlayPath: "/tmp/cursor.png",
        cursor: { enabled: true, track: [{ t: 0, x: 0.5, y: 0.5 }, { t: 1000, x: 0.6, y: 0.4 }] },
      }),
    );
    expect(graph.inputPaths).toHaveLength(2);
    expect(graph.filterComplex).toContain("overlay=");
  });

  it("skips rounded corners when no mask was rendered", () => {
    // Default framing has a 12px radius, but without a mask path there is
    // nothing to overlay — the graph must stay valid rather than reference a
    // missing input.
    const graph = buildGraph(plan());
    expect(graph.inputPaths).toHaveLength(1);
    expect(graph.filterComplex).toContain("[padded]format=");
  });

  it("overlays four wedges on the content corners when a mask is given", () => {
    const graph = buildGraph(plan({ cornerMaskPath: "/tmp/corner.png" }));
    expect(graph.inputPaths).toEqual(["/tmp/in.mp4", "/tmp/corner.png"]);
    expect(graph.filterComplex).toContain("split=4[tl][trRaw][blRaw][brRaw]");
    expect(graph.filterComplex).toContain("[trRaw]hflip[tr]");
    expect(graph.filterComplex).toContain("[blRaw]vflip[bl]");
    expect(graph.filterComplex).toContain("[brRaw]hflip,vflip[br]");
    // 1920x1080 fitted into the 1792x952 content box becomes 1692x952 at
    // offset 114,64 — the wedges sit there and at (offset + size - radius).
    expect(graph.filterComplex).toContain("[tl]overlay=114:64");
    expect(graph.filterComplex).toContain("[br]overlay=1794:1004");
    expect(graph.filterComplex).toContain("[rounded]format=");
  });

  it("gives the corner mask its own input index alongside the cursor sprite", () => {
    const graph = buildGraph(
      plan({
        cornerMaskPath: "/tmp/corner.png",
        cursorOverlayPath: "/tmp/cursor.png",
        cursorStyle: { highlight: true, radiusScale: 0.06, smoothingMs: 450, zoomFollow: true },
        cursor: { enabled: true, track: [{ t: 0, x: 0.5, y: 0.5 }, { t: 1000, x: 0.6, y: 0.4 }] },
      }),
    );
    expect(graph.inputPaths).toEqual(["/tmp/in.mp4", "/tmp/cursor.png", "/tmp/corner.png"]);
    // Cursor is input 1, mask is input 2 — neither may be hardcoded.
    expect(graph.filterComplex).toContain("[1:v]scale=");
    expect(graph.filterComplex).toContain("[2:v]scale=");
  });

  it("chains callouts after the rounded corners, not before them", () => {
    const graph = buildGraph(
      plan({
        cornerMaskPath: "/tmp/corner.png",
        fontFile: "/usr/share/fonts/x.ttf",
        callouts: [
          {
            id: "1",
            t: 0,
            durationMs: 500,
            x: 0.5,
            y: 0.5,
            text: "hi",
            fontSize: 24,
            color: "#ffffff",
            boxColor: "#000000@0.8",
          },
        ],
      }),
    );
    // `[padded]` is consumed by the first corner overlay; reusing it here would
    // make ffmpeg reject the graph with a duplicate-label error.
    expect(graph.filterComplex).toContain("[rounded]drawtext=");
    expect(graph.filterComplex).toContain("[withtext]format=");
  });

  it("treats the cursor track as clip-relative", () => {
    // A track already rebased by `toClipTime` starts at 0 even though the trim
    // starts at 1s; the overlay expression must not re-add the trim offset.
    const graph = buildGraph(
      plan({
        trim: { startMs: 1000, endMs: 3000 },
        cursorOverlayPath: "/tmp/cursor.png",
        cursorStyle: { highlight: true, radiusScale: 0.06, smoothingMs: 450, zoomFollow: true },
        cursor: { enabled: true, track: [{ t: 0, x: 0.2, y: 0.2 }, { t: 1000, x: 0.8, y: 0.8 }] },
      }),
    );
    expect(graph.filterComplex).toContain("lt(t,1)");
    expect(graph.filterComplex).not.toContain("lt(t,2)");
  });

  it("escapes callout text and requires a font", () => {
    const graph = buildGraph(
      plan({
        fontFile: "/usr/share/fonts/x.ttf",
        callouts: [
          {
            id: "1",
            t: 200,
            durationMs: 1000,
            x: 0.5,
            y: 0.5,
            text: "Hello: world",
            fontSize: 32,
            color: "#ffffff",
            boxColor: "#000000@0.8",
          },
        ],
      }),
    );
    expect(graph.filterComplex).toContain("drawtext=");
    expect(graph.filterComplex).toContain("Hello\\: world");
    expect(graph.filterComplex).toContain("fontfile=");
  });
});

describe("buildRenderArgs", () => {
  it("includes inputs, map, codec and output", () => {
    const args = buildRenderArgs(plan());
    expect(args[0]).toBe("ffmpeg");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/in.mp4");
    expect(args).toContain("-map");
    expect(args).toContain("[vout]");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });

  it("adds a looped second input when a cursor sprite is used", () => {
    const args = buildRenderArgs(
      plan({
        cursorOverlayPath: "/tmp/cursor.png",
        cursor: { enabled: true, track: [{ t: 0, x: 0.5, y: 0.5 }, { t: 1000, x: 0.4, y: 0.6 }] },
      }),
    );
    expect(args).toContain("-loop");
    expect(args).toContain("/tmp/cursor.png");
  });
});

describe("poster + probe helpers", () => {
  it("chooses a poster time inside the trim", () => {
    const at = choosePosterTime({ startMs: 1000, endMs: 5000 });
    expect(at).toBeGreaterThanOrEqual(1000);
    expect(at).toBeLessThanOrEqual(5000);
    expect(choosePosterTime({ startMs: 0, endMs: 1000 }, 250)).toBe(250);
  });

  it("builds probe args", () => {
    const args = buildProbeArgs("/tmp/out.mp4");
    expect(args[0]).toBe("ffprobe");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });
});

describe("stage layout shared with the preview", () => {
  it("places the content centred inside the padding", () => {
    const layout = computeStageLayout({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      framing: { ...DEFAULT_FRAMING, paddingPx: 48 },
      presetId: "mp4-1080p",
    });
    expect(layout.out).toEqual({ width: 1920, height: 1080 });
    // 1920x1080 inside a 1824x984 box is height-bound.
    expect(layout.content.height).toBe(984);
    expect(layout.content.x).toBe((1920 - layout.content.width) / 2);
    expect(layout.content.y).toBe(48);
  });

  it("clamps the corner radius to half the content box", () => {
    const layout = computeStageLayout({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { x: 0, y: 0, width: 1, height: 0.05 },
      framing: { ...DEFAULT_FRAMING, cornerRadiusPx: 400 },
      presetId: "mp4-1080p",
    });
    expect(layout.radiusPx).toBe(Math.floor(layout.content.height / 2));
  });

  it("is the same geometry the graph is built from", () => {
    const p = plan({
      crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
      framing: { ...DEFAULT_FRAMING, paddingPx: 32 },
    });
    const layout = computeStageLayout({
      sourceWidth: p.sourceWidth,
      sourceHeight: p.sourceHeight,
      crop: p.crop,
      framing: p.framing,
      presetId: p.presetId,
    });
    const graph = buildGraph(p).filterComplex;
    expect(graph).toContain(
      `crop=${layout.base.width}:${layout.base.height}:${layout.base.x}:${layout.base.y}`,
    );
    expect(graph).toContain(`scale=${layout.content.width}:${layout.content.height}`);
    expect(graph).toContain(
      `pad=${layout.out.width}:${layout.out.height}:${layout.content.x}:${layout.content.y}`,
    );
  });
});

describe("zoom window", () => {
  it("never goes below 1, matching the zoompan clamp", () => {
    expect(zoomWindow(0.4, 0.5, 0.5)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("centres the window on the focus point", () => {
    expect(zoomWindow(2, 0.5, 0.5)).toEqual({ scale: 2, x: 0.25, y: 0.25 });
  });

  it("keeps the window inside the frame when the focus is at an edge", () => {
    expect(zoomWindow(2, 0, 1)).toEqual({ scale: 2, x: 0, y: 0.5 });
  });
});

describe("callout box clamping", () => {
  it("centres a box that fits", () => {
    expect(clampTextBox(500, 100, 1000)).toBe(450);
  });

  it("pushes a box back inside both edges", () => {
    expect(clampTextBox(0, 100, 1000)).toBe(0);
    expect(clampTextBox(1000, 100, 1000)).toBe(900);
  });

  it("pins a box wider than the canvas to the left edge, as drawtext does", () => {
    expect(clampTextBox(500, 1200, 1000)).toBe(0);
  });
});
