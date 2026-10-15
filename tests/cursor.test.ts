import { describe, expect, it } from "vitest";
import {
  buildZoomTimeline,
  clusterCursor,
  easeInOut,
  evaluateZoom,
  scaleForIntensity,
} from "../src/core/cursor.js";
import type { Point } from "../src/core/types.js";

function track(points: Array<[number, number, number]>): Point[] {
  return points.map(([t, x, y]) => ({ t, x, y }));
}

describe("easeInOut", () => {
  it("is symmetric and clamped", () => {
    expect(easeInOut(0)).toBeCloseTo(0, 6);
    expect(easeInOut(1)).toBeCloseTo(1, 6);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOut(-3)).toBeCloseTo(0, 6);
    expect(easeInOut(9)).toBeCloseTo(1, 6);
  });

  it("is monotonic across its domain", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i += 1) {
      const value = easeInOut(i / 20);
      expect(value).toBeGreaterThanOrEqual(prev);
      prev = value;
    }
  });
});

describe("scaleForIntensity", () => {
  it("maps intensity 0..1 to 1.0..2.5x", () => {
    expect(scaleForIntensity(0)).toBeCloseTo(1);
    expect(scaleForIntensity(1)).toBeCloseTo(2.5);
    expect(scaleForIntensity(0.5)).toBeCloseTo(1.75);
  });
});

describe("clusterCursor", () => {
  it("splits on idle gaps and returns activity centroids", () => {
    const points = track([
      [0, 0.2, 0.2],
      [200, 0.25, 0.2],
      [400, 0.3, 0.25],
      // long idle gap
      [5000, 0.7, 0.7],
      [5200, 0.72, 0.7],
      [5400, 0.75, 0.72],
    ]);
    const clusters = clusterCursor(points, 1000);
    expect(clusters.length).toBe(2);
    expect(clusters[0]!.x).toBeCloseTo(0.25, 1);
    expect(clusters[1]!.x).toBeCloseTo(0.723, 1);
  });

  it("handles empty input", () => {
    expect(clusterCursor([], 1000)).toEqual([]);
  });
});

describe("buildZoomTimeline", () => {
  it("starts and ends at 1x", () => {
    const points = track([
      [500, 0.2, 0.2],
      [700, 0.3, 0.3],
      [900, 0.4, 0.4],
    ]);
    const timeline = buildZoomTimeline(points, { durationMs: 2000, intensity: 0.5 });
    expect(timeline[0]!.scale).toBe(1);
    expect(timeline[timeline.length - 1]!.scale).toBe(1);
  });

  it("zooms to the configured maximum over the activity cluster", () => {
    const points = track([
      [500, 0.2, 0.2],
      [700, 0.21, 0.2],
      [900, 0.22, 0.21],
      [1100, 0.23, 0.21],
    ]);
    const timeline = buildZoomTimeline(points, {
      durationMs: 2000,
      intensity: 1,
      smoothingMs: 300,
    });
    const max = Math.max(...timeline.map((k) => k.scale));
    expect(max).toBeCloseTo(2.5, 5);
    // Focus point tracks the cluster centroid.
    const peak = timeline.find((k) => k.scale === max)!;
    expect(peak.cx).toBeGreaterThan(0.2);
    expect(peak.cx).toBeLessThan(0.25);
  });

  it("returns a flat timeline when there is no activity", () => {
    const timeline = buildZoomTimeline([], { durationMs: 1000 });
    expect(timeline).toHaveLength(2);
    expect(timeline.every((k) => k.scale === 1)).toBe(true);
  });

  it("produces keyframes inside the duration and sorted", () => {
    const points = track([
      [100, 0.5, 0.5],
      [300, 0.55, 0.5],
      [700, 0.6, 0.55],
    ]);
    const timeline = buildZoomTimeline(points, { durationMs: 1500 });
    const times = timeline.map((k) => k.t);
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...times)).toBeLessThanOrEqual(1500);
  });
});

describe("evaluateZoom", () => {
  const keyframes = [
    { t: 0, scale: 1, cx: 0.5, cy: 0.5 },
    { t: 1000, scale: 2, cx: 0.2, cy: 0.3 },
    { t: 2000, scale: 2, cx: 0.2, cy: 0.3 },
    { t: 3000, scale: 1, cx: 0.5, cy: 0.5 },
  ];

  it("clamps outside the keyframe range", () => {
    expect(evaluateZoom(keyframes, -100).scale).toBe(1);
    expect(evaluateZoom(keyframes, 99999).scale).toBe(1);
  });

  it("returns exact values at keyframe times", () => {
    expect(evaluateZoom(keyframes, 1000).scale).toBeCloseTo(2, 5);
    expect(evaluateZoom(keyframes, 2000).scale).toBeCloseTo(2, 5);
  });

  it("interpolates smoothly between keyframes", () => {
    const mid = evaluateZoom(keyframes, 500);
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(2);
    expect(mid.cx).toBeLessThan(0.5);
    expect(mid.cx).toBeGreaterThan(0.2);
  });

  it("falls back to a default when empty", () => {
    expect(evaluateZoom([], 123, 1.25)).toEqual({ scale: 1.25, cx: 0.5, cy: 0.5 });
  });
});
