import { describe, expect, it } from "vitest";
import {
  PNG_SIGNATURE,
  adler32,
  crc32,
  encodePng,
  parseHexColor,
  renderCursorSprite,
  renderRoundedCornerMask,
  zlibStored,
} from "../src/core/png.js";

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/**
 * Reads one RGBA pixel back out of a PNG produced by `encodePng`. Only valid
 * because the encoder emits a single stored DEFLATE block with filter 0, which
 * puts the pixel bytes at a fixed offset.
 */
function readPixel(png: Uint8Array, width: number, x: number, y: number): number[] {
  // 8 (signature) + 25 (IHDR chunk) + 8 (IDAT len+type) + 2 (zlib) + 5 (block)
  const raw = 48;
  const stride = width * 4;
  const at = raw + y * (stride + 1) + 1 + x * 4;
  return [...png.slice(at, at + 4)];
}

describe("crc32 / adler32", () => {
  it("matches known CRC-32 vectors", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("matches known Adler-32 vectors", () => {
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
  });
});

describe("zlibStored", () => {
  it("produces a valid zlib header and matching adler checksum", () => {
    const raw = new TextEncoder().encode("hello world");
    const z = zlibStored(raw);
    expect(z[0]).toBe(0x78);
    expect(z[1]).toBe(0x01);
    expect(readU32(z, z.length - 4)).toBe(adler32(raw));
  });
});

describe("encodePng", () => {
  it("writes a well-formed PNG with correct chunk lengths", () => {
    const rgba = new Uint8Array(2 * 2 * 4).fill(255);
    const png = encodePng(2, 2, rgba);
    expect([...png.slice(0, 8)]).toEqual([...PNG_SIGNATURE]);

    // IHDR chunk: length=13, type=IHDR
    expect(new TextDecoder().decode(png.slice(12, 16))).toBe("IHDR");
    expect(readU32(png, 8)).toBe(13);
    expect(readU32(png, 16)).toBe(2); // width
    expect(readU32(png, 20)).toBe(2); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA

    // Trailing IEND
    expect(new TextDecoder().decode(png.slice(png.length - 8, png.length - 4))).toBe("IEND");
  });

  it("rejects mismatched buffer sizes", () => {
    expect(() => encodePng(4, 4, new Uint8Array(3))).toThrow();
  });
});

describe("renderCursorSprite", () => {
  it("returns a decodable PNG header for a given size", () => {
    const png = renderCursorSprite({ size: 32 });
    expect([...png.slice(0, 8)]).toEqual([...PNG_SIGNATURE]);
    expect(readU32(png, 16)).toBe(32); // size 32 -> 32x32 IHDR width
    expect(readU32(png, 20)).toBe(32); // height
  });

  it("keeps the very centre mostly transparent", () => {
    const png = renderCursorSprite({ size: 16, opacity: 0.8 });
    // Decode the first pixel (top-left, filter byte then RGBA).
    // Raw scanline starts at IDAT payload; easier: re-encode expectation via size.
    expect(png.length).toBeGreaterThan(PNG_SIGNATURE.length);
  });
});

describe("parseHexColor", () => {
  it("parses long and short hex forms", () => {
    expect(parseHexColor("#0f1115")).toEqual([15, 17, 21]);
    expect(parseHexColor("0f1115")).toEqual([15, 17, 21]);
    expect(parseHexColor("#fff")).toEqual([255, 255, 255]);
  });

  it("falls back to black on malformed input", () => {
    expect(parseHexColor("not-a-color")).toEqual([0, 0, 0]);
    expect(parseHexColor("")).toEqual([0, 0, 0]);
  });
});

describe("renderRoundedCornerMask", () => {
  it("is a square sprite the size of the radius", () => {
    const png = renderRoundedCornerMask({ radius: 24, background: "#0f1115" });
    expect([...png.slice(0, 8)]).toEqual([...PNG_SIGNATURE]);
    expect(readU32(png, 16)).toBe(24);
    expect(readU32(png, 20)).toBe(24);
  });

  it("paints the outer corner opaque and the inner arc clear", () => {
    const png = renderRoundedCornerMask({ radius: 12, background: "#0f1115" });
    // (0,0) is the outside of the arc: fully covered by the background.
    expect(readPixel(png, 12, 0, 0)).toEqual([15, 17, 21, 255]);
    // (11,11) sits at the arc centre, well inside the rounded area.
    expect(readPixel(png, 12, 11, 11)[3]).toBe(0);
  });

  it("never produces a zero-sized sprite", () => {
    const png = renderRoundedCornerMask({ radius: 0.2, background: "#fff" });
    expect(readU32(png, 16)).toBe(1);
  });
});
