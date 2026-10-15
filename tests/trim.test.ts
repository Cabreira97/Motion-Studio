import { describe, expect, it } from "vitest";
import { MIN_CLIP_MS, clipTimeFor, normalizeTrim, sourceTimeFor } from "../src/core/trim.js";

describe("normalizeTrim", () => {
  it("keeps a valid in-range trim", () => {
    const trim = normalizeTrim({ startMs: 1000, endMs: 3000 }, 10_000, 30);
    expect(trim.startMs).toBe(1000);
    expect(trim.endMs).toBe(3000);
    expect(trim.durationMs).toBe(2000);
  });

  it("clamps the end to the media duration", () => {
    const trim = normalizeTrim({ startMs: 0, endMs: 99_999 }, 5_000, 30);
    expect(trim.endMs).toBeLessThanOrEqual(5_000);
  });

  it("clamps a negative start to zero", () => {
    const trim = normalizeTrim({ startMs: -500, endMs: 2_000 }, 5_000, 30);
    expect(trim.startMs).toBe(0);
  });

  it("enforces a minimum clip length", () => {
    const trim = normalizeTrim({ startMs: 1000, endMs: 1000 }, 5_000, 30);
    expect(trim.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_MS);
  });

  it("snaps to frame boundaries", () => {
    const trim = normalizeTrim({ startMs: 33, endMs: 1033 }, 10_000, 30);
    const frameMs = 1000 / 30;
    expect(Math.abs(trim.startMs - Math.round(trim.startMs / frameMs) * frameMs)).toBeLessThan(1e-6);
  });

  it("handles media shorter than the minimum length", () => {
    const trim = normalizeTrim({ startMs: 0, endMs: 100 }, 100, 30);
    expect(trim.startMs).toBe(0);
    expect(trim.durationMs).toBeGreaterThan(0);
  });
});

describe("clip/source time mapping", () => {
  const trim = { startMs: 2000, endMs: 5000 };

  it("maps clip time into source time", () => {
    expect(sourceTimeFor(0, trim)).toBe(2000);
    expect(sourceTimeFor(1500, trim)).toBe(3500);
  });

  it("maps source time into clip time, or -1 when outside", () => {
    expect(clipTimeFor(2500, trim)).toBe(500);
    expect(clipTimeFor(100, trim)).toBe(-1);
    expect(clipTimeFor(9000, trim)).toBe(-1);
  });
});
