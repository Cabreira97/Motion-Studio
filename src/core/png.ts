/**
 * Tiny, dependency-free PNG encoder (RGBA, 8-bit, no interlacing) using
 * *stored* (uncompressed) DEFLATE blocks. This lets us generate the cursor
 * highlight sprite at runtime without shipping binary assets or pulling in a
 * canvas/PNG library, and keeps it fully unit-testable.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/** Wraps raw bytes in a zlib stream using stored DEFLATE blocks. */
export function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const MAX = 65535;
  if (raw.length === 0) {
    blocks.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
  }
  for (let offset = 0; offset < raw.length; offset += MAX) {
    const len = Math.min(MAX, raw.length - offset);
    const final = offset + len >= raw.length ? 1 : 0;
    const header = new Uint8Array([final, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff]);
    blocks.push(header, raw.subarray(offset, offset + len));
  }
  const total = blocks.reduce((acc, b) => acc + b.length, 0);
  const out = new Uint8Array(2 + total + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let cursor = 2;
  for (const block of blocks) {
    out.set(block, cursor);
    cursor += block.length;
  }
  out.set(u32(adler32(raw)), cursor);
  return out;
}

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Encodes an RGBA pixel buffer (length = width*height*4) as a PNG.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("PNG dimensions must be positive integers");
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`RGBA buffer length ${rgba.length} does not match ${width}x${height}`);
  }

  // Each scanline is prefixed by a filter byte (0 = None).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlibStored(raw);
  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}

export interface CursorSpriteOptions {
  /** Sprite diameter in pixels. */
  size: number;
  /** RGB accent color (0..255). */
  color?: [number, number, number];
  /** Peak opacity of the soft disc (0..1). */
  opacity?: number;
}

/**
 * Draws a soft glowing disc used as the cursor highlight overlay. The centre
 * is transparent so the actual cursor remains visible, with a bright ring and
 * a soft halo around it.
 */
export function renderCursorSprite(options: CursorSpriteOptions): Uint8Array {
  const size = Math.max(8, Math.round(options.size));
  const [r, g, b] = options.color ?? [255, 213, 74];
  const peak = options.opacity ?? 0.6;
  const rgba = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  const radius = center;
  const ringInner = 0.72;
  const ringOuter = 0.92;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy) / radius;
      let alpha = 0;
      if (dist <= 1) {
        if (dist < ringInner) {
          // Soft halo fading toward the (transparent) centre.
          alpha = Math.pow(Math.max(0, ringInner - dist) / ringInner, 1.5) * peak * 0.6;
        } else if (dist <= ringOuter) {
          // Bright ring.
          alpha = peak;
        } else {
          // Outer falloff.
          alpha = Math.max(0, 1 - (dist - ringOuter) / (1 - ringOuter)) * peak * 0.5;
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    }
  }

  return encodePng(size, size, rgba);
}
