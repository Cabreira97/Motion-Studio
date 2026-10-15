import { describe, expect, it } from "vitest";
import {
  clampRect,
  isValidColor,
  isValidName,
  validateProject,
} from "../src/core/validation.js";
import { createProject } from "../src/core/project.js";

function baseProject() {
  return createProject({
    id: "p1",
    name: "Valid",
    captureKind: "window",
    mic: false,
    source: {
      path: "/tmp/in.mp4",
      width: 1280,
      height: 720,
      durationMs: 4000,
      fps: 30,
      hasAudio: false,
    },
  });
}

describe("isValidColor / isValidName", () => {
  it("accepts hex colors", () => {
    expect(isValidColor("#fff")).toBe(true);
    expect(isValidColor("#0f1115")).toBe(true);
    expect(isValidColor("#0f1115ff")).toBe(true);
    expect(isValidColor("red")).toBe(false);
    expect(isValidColor(123)).toBe(false);
  });

  it("validates names", () => {
    expect(isValidName("Hello")).toBe(true);
    expect(isValidName("   ")).toBe(false);
    expect(isValidName("x".repeat(121))).toBe(false);
  });
});

describe("clampRect", () => {
  it("keeps rects inside the frame with a minimum size", () => {
    const rect = clampRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
    expect(rect.x + rect.width).toBeLessThanOrEqual(1.0001);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1.0001);
    expect(rect.width).toBeGreaterThanOrEqual(0.05);
  });
});

describe("validateProject", () => {
  it("passes for a well-formed project", () => {
    const result = validateProject(baseProject());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags a missing source", () => {
    const project = { ...baseProject(), source: null };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("source");
  });

  it("flags an invalid trim range", () => {
    const project = baseProject();
    project.trim = { startMs: 1000, endMs: 1000 };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
  });

  it("flags invalid colors and fps", () => {
    const project = baseProject();
    project.framing.background = "not-a-color";
    project.framing.fps = 0;
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("flags malformed callouts and cursor points", () => {
    const project = baseProject();
    project.callouts.push({
      id: "c",
      t: -5,
      durationMs: 10,
      x: 1.5,
      y: 0.5,
      text: "x".repeat(500),
      fontSize: 12,
      color: "blue",
      boxColor: "#000",
    });
    project.cursorTrack.push({ t: Number.NaN, x: 0, y: 0 });
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("callout");
  });
});
