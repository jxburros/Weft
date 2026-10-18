#!/usr/bin/env node
// Encodes the Windows installer bitmaps that Vixl draws (scripts/graphics/installer.py writes
// packaging/source/*.png and their .vixl masters) as the 24-bit BMPs NSIS expects. Run
// `node scripts/generate-installer-art.js` after rebuilding them; test/release.test.js fails when
// the committed bitmaps drift from the PNGs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);

/** Minimal PNG decoder for the committed 8-bit, non-interlaced RGBA logo exports. */
export function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let offset = 8, width, height, depth, type, interlace;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (kind === 'IDAT') data.push(body);
    else if (kind === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || type !== 6 || interlace !== 0) throw new Error('Only 8-bit non-interlaced RGBA PNG input is supported');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= 4 && y ? pixels[(y - 1) * stride + x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
        value += a <= b && a <= c ? left : b <= c ? up : corner;
      } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = value & 255;
    }
  }
  return { width, height, pixels };
}

/** Uncompressed bottom-up 24-bit BMP (the format NSIS Modern UI expects). */
export function encodeBmp({ width, height, pixels }) {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM', 0, 'latin1');
  bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34); bytes.writeInt32LE(2835, 38); bytes.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = ((height - 1 - y) * width + x) * 3, target = 54 + y * stride + x * 3;
    // BMP stores BGR.
    for (let c = 0; c < 3; c++) bytes[target + c] = Math.max(0, Math.min(255, Math.round(pixels[source + 2 - c])));
  }
  return bytes;
}

/** The opaque Vixl export as the RGB pixels encodeBmp takes. */
function bitmap(name) {
  const { width, height, pixels } = decodePng(readFileSync(new URL(`packaging/source/${name}.png`, root)));
  const rgb = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * 4 + c];
  return { width, height, pixels: rgb };
}

export function renderInstallerArt() {
  return Object.fromEntries(['installer-sidebar', 'uninstaller-sidebar', 'installer-header'].map((name) => [`packaging/${name}.bmp`, encodeBmp(bitmap(name))]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(new URL('packaging/', root), { recursive: true });
  for (const [path, bytes] of Object.entries(renderInstallerArt())) {
    writeFileSync(new URL(path, root), bytes);
    console.log(`${path} ${bytes.length} bytes`);
  }
}
