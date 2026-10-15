import { describe, expect, it } from "vitest";
import { joinPath, safeFilename, uniqueName, withExtension } from "../src/core/filenames.js";

describe("safeFilename", () => {
  it("keeps ordinary names", () => {
    expect(safeFilename("My Recording")).toBe("My Recording");
  });

  it("strips path separators and traversal", () => {
    expect(safeFilename("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFilename("C:\\Windows\\System32")).toBe("C-Windows-System32");
    expect(safeFilename("a/b\\c")).toBe("a-b-c");
  });

  it("removes characters that are illegal on Windows/macOS", () => {
    expect(safeFilename('weird:name*?"><|')).toBe("weird-name");
  });

  it("trims leading dots and dashes and collapses separators", () => {
    expect(safeFilename("...hidden---file..")).toBe("hidden-file");
  });

  it("avoids reserved Windows device names", () => {
    expect(safeFilename("CON")).toBe("_CON");
    expect(safeFilename("com1.txt")).toBe("_com1.txt");
    expect(safeFilename("NUL")).toBe("_NUL");
  });

  it("falls back when the result would be empty or not a string", () => {
    expect(safeFilename("   ", { fallback: "recording" })).toBe("recording");
    expect(safeFilename("///", { fallback: "recording" })).toBe("recording");
    expect(safeFilename(undefined, { fallback: "clip" })).toBe("clip");
    expect(safeFilename(42, { fallback: "clip" })).toBe("clip");
  });

  it("enforces a maximum length", () => {
    const name = safeFilename("x".repeat(500), { maxLength: 32 });
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it("never returns characters that escape a directory", () => {
    const samples = ["..", "....", "../..", "a/../../b", "\u0000evil"];
    for (const sample of samples) {
      const result = safeFilename(sample);
      expect(result).not.toContain("/");
      expect(result).not.toContain("\\");
      expect(result.startsWith(".")).toBe(false);
    }
  });
});

describe("withExtension", () => {
  it("appends a single extension", () => {
    expect(withExtension("My Clip", "mp4")).toBe("My Clip.mp4");
    expect(withExtension("My Clip", ".webm")).toBe("My Clip.webm");
  });
});

describe("joinPath", () => {
  it("joins and re-sanitizes", () => {
    expect(joinPath("/tmp/out/", "../evil")).toBe("/tmp/out/evil");
  });
});

describe("uniqueName", () => {
  it("adds a numeric suffix when taken", () => {
    const used = new Set(["clip.mp4", "clip-2.mp4"]);
    expect(uniqueName("clip.mp4", used)).toBe("clip-3.mp4");
    expect(uniqueName("fresh.mp4", used)).toBe("fresh.mp4");
  });
});
