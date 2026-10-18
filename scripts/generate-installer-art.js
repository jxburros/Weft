#!/usr/bin/env node
// Deterministically renders the Windows installer bitmaps from the brand tokens and
// committed logo PNGs. Run `node scripts/generate-installer-art.js` after a palette or
// logo change; test/release.test.js fails when the committed bitmaps drift.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('assets/tokens.json', root), 'utf8'));
const light = tokens.themes.light;
const hex = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));

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

/** Area-average resample with premultiplied alpha (pure arithmetic, so output is reproducible). */
function resample(image, width, height) {
  const out = new Float64Array(width * height * 4);
  const sx = image.width / width, sy = image.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0, a = 0, total = 0;
    const x0 = x * sx, x1 = (x + 1) * sx, y0 = y * sy, y1 = (y + 1) * sy;
    for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
      const wy = Math.min(py + 1, y1) - Math.max(py, y0);
      for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
        const weight = wy * (Math.min(px + 1, x1) - Math.max(px, x0));
        const index = (py * image.width + px) * 4;
        const alpha = image.pixels[index + 3] / 255;
        r += image.pixels[index] * alpha * weight; g += image.pixels[index + 1] * alpha * weight; b += image.pixels[index + 2] * alpha * weight;
        a += alpha * weight; total += weight;
      }
    }
    const index = (y * width + x) * 4;
    out[index] = r / total; out[index + 1] = g / total; out[index + 2] = b / total; out[index + 3] = a / total;
  }
  return { width, height, out };
}

function canvas(width, height, color) {
  const pixels = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.set(color, i * 3);
  return { width, height, pixels };
}
function fill(target, x, y, width, height, color, opacity = 1) {
  for (let py = Math.max(0, y); py < Math.min(target.height, y + height); py++) for (let px = Math.max(0, x); px < Math.min(target.width, x + width); px++) {
    const index = (py * target.width + px) * 3;
    for (let c = 0; c < 3; c++) target.pixels[index + c] = target.pixels[index + c] * (1 - opacity) + color[c] * opacity;
  }
}
function draw(target, logo, width, left, top) {
  const height = Math.round(logo.height * width / logo.width);
  const scaled = resample(logo, width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, alpha = scaled.out[source + 3];
    const index = ((top + y) * target.width + left + x) * 3;
    // Premultiplied "over" compositing.
    for (let c = 0; c < 3; c++) target.pixels[index + c] = scaled.out[source + c] + target.pixels[index + c] * (1 - alpha);
  }
  return height;
}
/** A restrained weave: alternating plum/sage weft threads over warp lines, faint enough to stay decorative. */
function weave(target, top, bottom) {
  const plum = hex(light.brand), sage = hex('#718676'), warp = hex(light.border);
  for (let x = 6; x < target.width; x += 12) fill(target, x, top, 1, bottom - top, warp, 0.7);
  for (let y = top, row = 0; y < bottom; y += 8, row++) {
    const color = row % 2 ? sage : plum;
    for (let x = row % 2 ? 0 : 6; x < target.width; x += 12) fill(target, x, y, 7, 2, color, 0.18 + 0.5 * ((y - top) / (bottom - top)) ** 2);
  }
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

const logo = name => decodePng(readFileSync(new URL(`assets/logo/${name}`, root)));
function sidebar(accentFirst) {
  // NSIS Modern UI welcome/finish bitmap: 164 x 314.
  const image = canvas(164, 314, hex(light.canvas));
  weave(image, 196, 300);
  draw(image, logo('png/stacked-full-color-256w@2x.png'), 92, 36, 44);
  const [first, second] = accentFirst ? [hex(light.brand), hex('#718676')] : [hex('#718676'), hex(light.brand)];
  fill(image, 0, 306, 110, 8, first);
  fill(image, 110, 306, 54, 8, second);
  return image;
}
function header() {
  // Header bitmap on the right of the white Modern UI header: 150 x 57.
  const image = canvas(150, 57, [255, 255, 255]);
  const height = Math.round(241 * 112 / 512);
  draw(image, logo('png/horizontal-full-color-256w@2x.png'), 112, 30, Math.floor((57 - height) / 2));
  return image;
}

export function renderInstallerArt() {
  return {
    'packaging/installer-sidebar.bmp': encodeBmp(sidebar(true)),
    'packaging/uninstaller-sidebar.bmp': encodeBmp(sidebar(false)),
    'packaging/installer-header.bmp': encodeBmp(header()),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(new URL('packaging/', root), { recursive: true });
  for (const [path, bytes] of Object.entries(renderInstallerArt())) {
    writeFileSync(new URL(path, root), bytes);
    console.log(`${path} ${bytes.length} bytes`);
  }
}
