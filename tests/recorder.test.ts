import { afterEach, describe, expect, it } from "vitest";
import {
  buildDisplayConstraints,
  describeCaptureFailure,
  hasMediaClusters,
  pickMimeType,
  preferredCaptureSize,
} from "../src/lib/recorder.js";

/** Replaces `MediaRecorder` with one that only supports `supported`. */
function withSupportedTypes(supported: string[]): void {
  Object.defineProperty(globalThis, "MediaRecorder", {
    value: { isTypeSupported: (type: string) => supported.includes(type) },
    configurable: true,
    writable: true,
  });
}

function fromHex(hex: string): Blob {
  const clean = hex.replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new Blob([bytes]);
}

/**
 * The exact 178 bytes WebKitGTK wrote for a capture that produced no picture:
 * two EBML headers and a `Tracks` element with no entries. `blob.size` calls
 * this a recording; ffprobe calls it "End of file".
 */
const HEADER_ONLY_WEBM =
  "1a45dfa301000000000000104282857765626d0042878104428581021a45dfa3" +
  "01000000000000104282857765626d0042878104428581021853806701ffffff" +
  "ffffffff1549a96601000000000000562ad7b1830f42404d80a5475374726561" +
  "6d6572206d6174726f736b616d75782076657273696f6e20312e32382e320057" +
  "41994753747265616d6572204d6174726f736b61206d75786572004461880b4b" +
  "1e95b5a247101654ae6b0100000000000000";

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

function withScreen(width: number, height: number, ratio: number): void {
  Object.defineProperty(globalThis, "screen", {
    value: { width, height },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "devicePixelRatio", {
    value: ratio,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "MediaRecorder");
  Reflect.deleteProperty(globalThis, "screen");
  Reflect.deleteProperty(globalThis, "devicePixelRatio");
});

describe("preferredCaptureSize", () => {
  it("asks for the screen in device pixels", () => {
    withScreen(1920, 1080, 2);
    expect(preferredCaptureSize()).toEqual({ width: 3840, height: 2160 });
  });

  it("rounds an odd side down to even", () => {
    // I420 halves chroma in both axes, so an odd side has no valid chroma
    // plane and the encoder refuses to configure.
    withScreen(1365, 767, 1);
    expect(preferredCaptureSize()).toEqual({ width: 1364, height: 766 });
  });

  it("falls back to 1080p with no screen to read", () => {
    expect(preferredCaptureSize()).toEqual({ width: 1920, height: 1080 });
  });
});

describe("pickMimeType", () => {
  it("declares opus only when an audio track is actually being recorded", () => {
    // Declaring audio on a video-only stream makes GStreamer's muxer wait for
    // buffers that never arrive, so the recording comes out frameless.
    withSupportedTypes(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm"]);
    expect(pickMimeType(true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickMimeType(false)).toBe("video/webm;codecs=vp9");
  });

  it("falls back through the codec list in order", () => {
    withSupportedTypes(["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8"]);
    expect(pickMimeType(true)).toBe("video/webm;codecs=vp8,opus");
    expect(pickMimeType(false)).toBe("video/webm;codecs=vp8");
  });

  it("falls back to plain webm when no candidate is supported", () => {
    withSupportedTypes([]);
    expect(pickMimeType(true)).toBe("video/webm");
    expect(pickMimeType(false)).toBe("video/webm");
  });

  it("does not touch MediaRecorder when the environment lacks it", () => {
    expect(pickMimeType(true)).toBe("video/webm");
  });
});

describe("describeCaptureFailure", () => {
  function named(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  it("repeats the constraints that were rejected", () => {
    // "Invalid constraint" alone names neither the constraint nor the value.
    const message = describeCaptureFailure(
      named("OverconstrainedError", "Invalid constraint"),
      { frameRate: { ideal: 30 } },
    );
    expect(message).toContain("Invalid constraint");
    expect(message).toContain('{"frameRate":{"ideal":30}}');
  });

  it("names both causes of a refusal, since they are indistinguishable here", () => {
    const message = describeCaptureFailure(named("NotAllowedError", "Permission denied"), true);
    expect(message).toContain("declined in the system picker");
    expect(message).toContain("denied it before the picker appeared");
  });

  it("keeps the name and message of an error it does not recognise", () => {
    const message = describeCaptureFailure(named("InvalidAccessError", "gesture required"), true);
    expect(message).toContain("InvalidAccessError");
    expect(message).toContain("gesture required");
  });

  it("survives a thrown non-Error", () => {
    expect(describeCaptureFailure("boom", true)).toContain("boom");
  });
});

describe("hasMediaClusters", () => {
  it("rejects the header-only file a stalled muxer produces", async () => {
    const blob = fromHex(HEADER_ONLY_WEBM);
    expect(blob.size).toBe(178);
    expect(await hasMediaClusters(blob)).toBe(false);
  });

  it("accepts a file once a cluster has been written", async () => {
    const withCluster = new Blob([fromHex(HEADER_ONLY_WEBM), fromHex("1f43b67501ffffffffffffff")]);
    expect(await hasMediaClusters(withCluster)).toBe(true);
  });

  it("rejects an empty blob", async () => {
    expect(await hasMediaClusters(new Blob())).toBe(false);
  });
});

describe("buildDisplayConstraints", () => {
  it("asks for the frame rate and the surface hint when both are supported", () => {
    withSupportedConstraints({ frameRate: true, displaySurface: true });
    const video = buildDisplayConstraints("window", 30, { width: 2560, height: 1440 });
    expect(video).not.toBe(true);
    expect(video).toMatchObject({
      frameRate: { ideal: 30 },
      displaySurface: "window",
    });
  });

  it("asks for a real resolution so the engine cannot pick its smallest preset", () => {
    // Left unasked, WebKitGTK negotiated 112x63 — right aspect, unusable size,
    // and the odd height alone was enough to stop the encoder configuring.
    withSupportedConstraints({ frameRate: true, width: true, height: true });
    expect(buildDisplayConstraints("screen", 30, { width: 3840, height: 2160 })).toMatchObject({
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    });
  });

  it("omits the size on an engine that does not support it", () => {
    withSupportedConstraints({ frameRate: true });
    const video = buildDisplayConstraints("screen", 30, { width: 3840, height: 2160 });
    expect(video).not.toHaveProperty("width");
    expect(video).not.toHaveProperty("height");
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
    expect(video).toEqual({ frameRate: { ideal: 24 } });
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
