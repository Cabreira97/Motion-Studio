import { afterEach, describe, expect, it } from "vitest";
import { buildDisplayConstraints } from "../src/lib/recorder.js";

/**
 * Stands in for `navigator.mediaDevices`. Only `getSupportedConstraints` is
 * needed: `buildDisplayConstraints` reads it synchronously and never captures.
 */
function withSupportedConstraints(supported: Record<string, boolean>): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getSupportedConstraints: () => supported } },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("buildDisplayConstraints", () => {
  it("asks for the frame rate and the surface hint when both are supported", () => {
    withSupportedConstraints({ frameRate: true, displaySurface: true });
    const video = buildDisplayConstraints("window", 30);
    expect(video).not.toBe(true);
    expect(video).toMatchObject({
      frameRate: { ideal: 30, max: 60 },
      displaySurface: "window",
    });
  });

  it("maps screen and region to a whole monitor", () => {
    withSupportedConstraints({ frameRate: true, displaySurface: true });
    for (const kind of ["screen", "region"] as const) {
      expect(buildDisplayConstraints(kind, 30)).toMatchObject({
        displaySurface: "monitor",
      });
    }
  });

  it("drops displaySurface on engines that do not implement it", () => {
    // WebKitGTK: sending it rejects the whole call with "Invalid constraint",
    // after the user has already picked a surface in the portal.
    withSupportedConstraints({ frameRate: true });
    const video = buildDisplayConstraints("window", 24);
    expect(video).toEqual({ frameRate: { ideal: 24, max: 60 } });
    expect(video).not.toHaveProperty("displaySurface");
  });

  it("falls back to a bare request when nothing is supported", () => {
    withSupportedConstraints({});
    expect(buildDisplayConstraints("screen", 30)).toBe(true);
  });

  it("survives an engine without getSupportedConstraints at all", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: {} },
      configurable: true,
      writable: true,
    });
    expect(buildDisplayConstraints("screen", 30)).toBe(true);
  });
});
