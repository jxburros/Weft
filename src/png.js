import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal pure-JavaScript PNG codec for redaction and comparison. Decoding
 * accepts every standard colour type and bit depth (including Adam7
 * interlacing) and produces 8-bit RGBA. Encoding always writes a fresh
 * RGBA image with only IHDR, IDAT and IEND chunks, so text, EXIF, ICC and
 * any other ancillary data from the source never survives re-encoding.
 */
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_PIXELS = 40_000_000;
const failure = message => Object.assign(new Error(`PNG_INVALID: ${message}`), { code: 'invalid_arguments' });
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export function isPng(bytes) { return Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE); }

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function unfilter(data, offset, width, height, bitsPerPixel) {
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    if (offset + 1 + stride > data.length) throw failure('image data is truncated');
    const type = data[offset];
    const row = out.subarray(y * stride, (y + 1) * stride);
    data.copy(row, 0, offset + 1, offset + 1 + stride);
    offset += 1 + stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0, up = previous[x], diagonal = x >= bpp ? previous[x - bpp] : 0;
      if (type === 1) row[x] = (row[x] + left) & 255;
      else if (type === 2) row[x] = (row[x] + up) & 255;
      else if (type === 3) row[x] = (row[x] + ((left + up) >> 1)) & 255;
      else if (type === 4) row[x] = (row[x] + paeth(left, up, diagonal)) & 255;
      else if (type !== 0) throw failure('unknown row filter');
    }
    previous = row;
  }
  return { rows: out, stride, offset };
}
function sample(rows, stride, x, y, depth, channel, channels) {
  if (depth === 8) return rows[y * stride + x * channels + channel];
  if (depth === 16) return rows[y * stride + (x * channels + channel) * 2];
  const bit = x * depth;
  const byte = rows[y * stride + (bit >> 3)];
  return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

/** Decode PNG bytes into { width, height, data: RGBA Buffer }. */
export function decodePng(bytes, { maxPixels = MAX_PIXELS } = {}) {
  if (!isPng(bytes)) throw failure('not a PNG image');
  let offset = 8, header = null, palette = null, transparency = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) throw failure('chunk is truncated');
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0 !== bytes.readUInt32BE(offset + 8 + length)) throw failure(`${type} chunk failed its CRC check`);
    offset += 12 + length;
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
      if (body[10] !== 0 || body[11] !== 0 || header.interlace > 1) throw failure('unsupported compression, filter or interlace method');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!header || !idat.length) throw failure('missing IHDR or IDAT');
  const { width, height, depth, colorType, interlace } = header;
  if (!CHANNELS[colorType] || !DEPTHS[colorType].includes(depth)) throw failure('unsupported colour type or bit depth');
  if (!width || !height || width * height > maxPixels) throw failure(`image dimensions ${width}x${height} exceed the ${maxPixels}-pixel limit`);
  if (colorType === 3 && !palette) throw failure('palette image without PLTE');
  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const expected = interlace ? ADAM7.reduce((sum, [x0, y0, dx, dy]) => {
    const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
    return w > 0 && h > 0 ? sum + h * (1 + Math.ceil((w * bitsPerPixel) / 8)) : sum;
  }, 0) : height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  let raw;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); } catch { throw failure('image data could not be decompressed within its declared size'); }
  const rgba = Buffer.alloc(width * height * 4);
  const max = (1 << Math.min(depth, 8)) - 1;
  const scale = value => depth === 16 || depth === 8 ? value : Math.round((value * 255) / max);
  const key = transparency && colorType !== 3 ? (colorType === 0 ? [transparency.readUInt16BE(0)] : [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)]) : null;
  const write = (rows, stride, w, h, place) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const target = place(x, y) * 4;
      if (colorType === 3) {
        const index = sample(rows, stride, x, y, depth, 0, 1);
        if (index * 3 + 2 >= palette.length) throw failure('palette index out of range');
        rgba[target] = palette[index * 3]; rgba[target + 1] = palette[index * 3 + 1]; rgba[target + 2] = palette[index * 3 + 2];
        rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
        continue;
      }
      const values = [];
      for (let channel = 0; channel < channels; channel++) values.push(sample(rows, stride, x, y, depth, channel, channels));
      const gray = colorType === 0 || colorType === 4;
      const [r, g, b] = gray ? [values[0], values[0], values[0]] : values;
      let alpha = colorType === 4 ? values[1] : colorType === 6 ? values[3] : max;
      if (key) {
        const full = depth === 16 ? (index => (rows[y * stride + (x * channels + index) * 2] << 8) | rows[y * stride + (x * channels + index) * 2 + 1]) : (index => values[index]);
        if (key.every((value, index) => full(index) === value)) alpha = 0;
      }
      rgba[target] = scale(r); rgba[target + 1] = scale(g); rgba[target + 2] = scale(b); rgba[target + 3] = depth === 16 || depth === 8 ? alpha : scale(alpha);
    }
  };
  if (!interlace) {
    const { rows, stride } = unfilter(raw, 0, width, height, bitsPerPixel);
    write(rows, stride, width, height, (x, y) => y * width + x);
  } else {
    let position = 0;
    for (const [x0, y0, dx, dy] of ADAM7) {
      const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
      if (w <= 0 || h <= 0) continue;
      const pass = unfilter(raw, position, w, h, bitsPerPixel);
      position = pass.offset;
      write(pass.rows, pass.stride, w, h, (x, y) => (y0 + y * dy) * width + x0 + x * dx);
    }
  }
  return { width, height, data: rgba };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode RGBA pixels as a new PNG containing only IHDR, IDAT and IEND. */
export function encodePng({ width, height, data }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) throw failure('invalid image buffer');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Sub filter: cheap and compresses large redacted (uniform) areas well.
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = (data[y * stride + x] - (x >= 4 ? data[y * stride + x - 4] : 0)) & 255;
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Clip and normalize rectangles in image pixels; empty or out-of-bounds areas are reported, not silently dropped. */
export function clipRects(rects, width, height) {
  return rects.map(rect => {
    const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
    const right = Math.min(width, Math.ceil(rect.x + rect.width)), bottom = Math.min(height, Math.ceil(rect.y + rect.height));
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  });
}

/** Replace every pixel inside the rectangles with opaque black. Returns the number of pixels replaced. */
export function fillRects(image, rects, color = [0, 0, 0, 255]) {
  let replaced = 0;
  for (const rect of rects) {
    if (!rect) continue;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const at = (y * image.width + x) * 4;
        image.data[at] = color[0]; image.data[at + 1] = color[1]; image.data[at + 2] = color[2]; image.data[at + 3] = color[3];
        replaced++;
      }
    }
  }
  return replaced;
}

/**
 * Pixel comparison of two decoded images. Images with different dimensions are
 * compared over their shared area and reported as not directly comparable.
 */
export function diffImages(a, b, { tolerance = 0, diffImage = false, maxDiffPixels = 4_000_000 } = {}) {
  const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
  let changed = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const output = diffImage && width * height <= maxDiffPixels ? Buffer.alloc(width * height * 4) : null;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
    let differs = false;
    for (let channel = 0; channel < 4; channel++) if (Math.abs(a.data[i + channel] - b.data[j + channel]) > tolerance) { differs = true; break; }
    if (differs) { changed++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    if (output) {
      const o = (y * width + x) * 4;
      if (differs) { output[o] = 220; output[o + 1] = 30; output[o + 2] = 60; output[o + 3] = 255; }
      else { const gray = Math.round((b.data[j] + b.data[j + 1] + b.data[j + 2]) / 3 * 0.35 + 160); output[o] = gray; output[o + 1] = gray; output[o + 2] = gray; output[o + 3] = 255; }
    }
  }
  const sameSize = a.width === b.width && a.height === b.height;
  const compared = width * height;
  return { comparable: sameSize, from: { width: a.width, height: a.height }, to: { width: b.width, height: b.height }, comparedPixels: compared, changedPixels: changed,
    changedRatio: compared ? Number((changed / compared).toFixed(6)) : 0, changedBounds: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    ...(output ? { diffPngBase64: encodePng({ width, height, data: output }).toString('base64') } : {}),
    ...(!sameSize ? { note: 'Images have different dimensions; only the shared top-left area was compared.' } : {}) };
}
