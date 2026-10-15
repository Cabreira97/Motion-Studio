import { describe, expect, it } from "vitest";
import { evaluateZoom } from "../src/core/cursor.js";
import {
  buildManualTimeline,
  clampStop,
  normalizeStops,
  DEFAULT_STOP_MS,
  MAX_ZOOM_SCALE,
  MIN_STOP_MS,
} from "../src/core/zoom.js";
import {
  addZoomStop,
  createProject,
  migrateProject,
  removeZoomStop,
  updateZoomStop,
  withTrim,
  withZoomMode,
} from "../src/core/project.js";
import { validateProject } from "../src/core/validation.js";
import type { Project, ZoomStop } from "../src/core/types.js";

function stop(overrides: Partial<ZoomStop> = {}): ZoomStop {
  return { id: "a", t: 1000, durationMs: 2000, scale: 2, cx: 0.3, cy: 0.7, ...overrides };
}

function project(): Project {
  return createProject({
    id: "p1",
    captureKind: "screen",
    mic: false,
    now: 1_000_000,
    source: {
      path: "/tmp/in.mp4",
      width: 1920,
      height: 1080,
      durationMs: 10_000,
      fps: 30,
      hasAudio: true,
    },
  });
}

describe("clampStop", () => {
  it("forces values into the supported ranges", () => {
    const clamped = clampStop(stop({ t: -50, durationMs: 10, scale: 99, cx: 5, cy: -2 }));
    expect(clamped.t).toBe(0);
    expect(clamped.durationMs).toBe(MIN_STOP_MS);
    expect(clamped.scale).toBe(MAX_ZOOM_SCALE);
    expect(clamped.cx).toBe(1);
    expect(clamped.cy).toBe(0);
  });

  it("replaces non-finite values with defaults", () => {
    const clamped = clampStop(stop({ t: NaN, durationMs: Infinity, scale: NaN, cx: NaN }));
    expect(clamped.t).toBe(0);
    expect(clamped.durationMs).toBe(DEFAULT_STOP_MS);
    expect(clamped.cx).toBe(0.5);
    expect(Number.isFinite(clamped.scale)).toBe(true);
  });
});

describe("normalizeStops", () => {
  it("sorts by time", () => {
    const sorted = normalizeStops([stop({ id: "b", t: 5000 }), stop({ id: "a", t: 1000 })]);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("shortens an earlier stop rather than dropping the new one", () => {
    // "a" holds 1000..3000; "b" starts at 2000, inside it.
    const sorted = normalizeStops([
      stop({ id: "a", t: 1000, durationMs: 2000 }),
      stop({ id: "b", t: 2000, durationMs: 1000 }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
    expect(sorted[0]!.durationMs).toBe(1000);
    expect(sorted[0]!.t + sorted[0]!.durationMs).toBeLessThanOrEqual(sorted[1]!.t);
  });

  it("skips a stop that cannot fit after the minimum hold", () => {
    // "b" starts only 100ms in, less than MIN_STOP_MS, so "a" cannot shrink enough.
    const sorted = normalizeStops([
      stop({ id: "a", t: 1000, durationMs: 2000 }),
      stop({ id: "b", t: 1100, durationMs: 1000 }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("buildManualTimeline", () => {
  it("opens and closes at 1x", () => {
    const kf = buildManualTimeline([stop()], 0, { durationMs: 8000 });
    expect(kf[0]!.t).toBe(0);
    expect(kf[0]!.scale).toBe(1);
    expect(kf[kf.length - 1]!.t).toBe(8000);
    expect(kf[kf.length - 1]!.scale).toBe(1);
  });

  it("holds the requested scale across the stop", () => {
    const kf = buildManualTimeline([stop({ t: 2000, durationMs: 2000, scale: 2 })], 0, {
      durationMs: 8000,
      smoothingMs: 400,
    });
    // Mid-hold is fully zoomed; well before the ramp it is still 1x.
    expect(evaluateZoom(kf, 3000).scale).toBeCloseTo(2, 5);
    expect(evaluateZoom(kf, 3000).cx).toBeCloseTo(0.3, 5);
    expect(evaluateZoom(kf, 500).scale).toBeCloseTo(1, 5);
  });

  it("rebases stops onto the trimmed clip", () => {
    // Trim starts at 2s, so a stop at 3s lands 1s into the clip.
    const kf = buildManualTimeline([stop({ t: 3000, durationMs: 1000, scale: 2 })], 2000, {
      durationMs: 5000,
      smoothingMs: 300,
    });
    expect(evaluateZoom(kf, 1500).scale).toBeCloseTo(2, 5);
    // The same moment in *source* time is outside the clip's zoomed stretch.
    expect(evaluateZoom(kf, 3500).scale).toBeCloseTo(1, 5);
  });

  it("drops stops that fall outside the clip", () => {
    const kf = buildManualTimeline(
      [stop({ id: "before", t: 0, durationMs: 500 }), stop({ id: "after", t: 9000 })],
      2000,
      { durationMs: 3000 },
    );
    // Nothing but the opening and closing 1x keyframes survive.
    expect(kf.every((k) => k.scale === 1)).toBe(true);
  });

  it("never emits a keyframe outside the clip", () => {
    const kf = buildManualTimeline([stop({ t: 0, durationMs: 9000 })], 0, { durationMs: 4000 });
    for (const k of kf) {
      expect(k.t).toBeGreaterThanOrEqual(0);
      expect(k.t).toBeLessThanOrEqual(4000);
    }
  });
});

describe("manual zoom on a project", () => {
  it("defaults to cursor mode with no stops", () => {
    const p = project();
    expect(p.zoom.mode).toBe("auto");
    expect(p.zoom.stops).toEqual([]);
  });

  it("adds, updates and removes stops, rebuilding the timeline each time", () => {
    let p = withZoomMode(project(), "manual");
    expect(p.zoom.keyframes.every((k) => k.scale === 1)).toBe(true);

    p = addZoomStop(p, { id: "s1", t: 2000, scale: 2.5, cx: 0.2, cy: 0.8 });
    expect(p.zoom.stops).toHaveLength(1);
    expect(p.zoom.keyframes.some((k) => k.scale === 2.5)).toBe(true);

    p = updateZoomStop(p, "s1", { scale: 1.5 });
    expect(p.zoom.keyframes.some((k) => k.scale === 2.5)).toBe(false);
    expect(p.zoom.keyframes.some((k) => k.scale === 1.5)).toBe(true);

    p = removeZoomStop(p, "s1");
    expect(p.zoom.stops).toHaveLength(0);
    expect(p.zoom.keyframes.every((k) => k.scale === 1)).toBe(true);
  });

  it("keeps manual stops when toggling back to cursor mode", () => {
    let p = addZoomStop(withZoomMode(project(), "manual"), { id: "s1", t: 2000 });
    p = withZoomMode(p, "auto");
    expect(p.zoom.stops).toHaveLength(1);
    p = withZoomMode(p, "manual");
    expect(p.zoom.keyframes.some((k) => k.scale > 1)).toBe(true);
  });

  it("re-aims the timeline when the trim moves", () => {
    let p = addZoomStop(withZoomMode(project(), "manual"), {
      id: "s1",
      t: 4000,
      durationMs: 1000,
      scale: 2,
    });
    expect(evaluateZoom(p.zoom.keyframes, 4500).scale).toBeCloseTo(2, 5);
    // Cutting 3s off the front moves the stop to 1s into the clip.
    p = withTrim(p, { startMs: 3000, endMs: 10_000 });
    expect(evaluateZoom(p.zoom.keyframes, 1500).scale).toBeCloseTo(2, 5);
  });

  it("produces a project that still validates", () => {
    const p = addZoomStop(withZoomMode(project(), "manual"), { id: "s1", t: 2000 });
    expect(validateProject(p).errors).toEqual([]);
  });

  it("rejects an out-of-range stop that bypassed the helpers", () => {
    const p = withZoomMode(project(), "manual");
    const broken = { ...p, zoom: { ...p.zoom, stops: [stop({ scale: 99 })] } };
    expect(validateProject(broken).valid).toBe(false);
  });
});

describe("migrateProject", () => {
  it("fills in zoom fields missing from older documents", () => {
    // An older document simply lacks the keys, so model it as a loose object
    // rather than deleting from the typed shape.
    const { mode: _mode, stops: _stops, ...zoom } = project().zoom;
    const old = { ...project(), zoom } as unknown as Project;

    const migrated = migrateProject(old);
    expect(migrated.zoom.mode).toBe("auto");
    expect(migrated.zoom.stops).toEqual([]);
    expect(migrated.zoom.keyframes).toBe(zoom.keyframes);
  });

  it("survives a document with nothing but the zoom key missing", () => {
    const { zoom: _zoom, ...rest } = project();
    const migrated = migrateProject(rest as unknown as Project);
    expect(migrated.zoom.mode).toBe("auto");
    expect(migrated.zoom.intensity).toBeCloseTo(0.45, 5);
  });

  it("clamps stops that were persisted out of range", () => {
    const p = project();
    const tampered = {
      ...p,
      zoom: { ...p.zoom, mode: "manual" as const, stops: [stop({ scale: 99, cx: -4 })] },
    };
    const migrated = migrateProject(tampered);
    expect(migrated.zoom.stops[0]!.scale).toBe(MAX_ZOOM_SCALE);
    expect(migrated.zoom.stops[0]!.cx).toBe(0);
  });
});
