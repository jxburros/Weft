/**
 * Small-size validation of the Weft logo (#36). Run with Electron (Chromium renders the SVGs
 * exactly as a browser or the OS would at each size):
 *
 *   npm run logo:validate                # print measurements, exit 1 if a small icon is illegible
 *   npm run logo:validate -- --write     # also write the contact sheet and favicon.ico
 *
 * Each supplied variant and the optical variant is rendered at 16, 24, 32, 48, 64, 128 and 256 px
 * and measured from the rendered pixels: how many separate band pieces remain (the over-under
 * crossing is legible only while the pieces stay apart), the band width in pixels, and the peak
 * contrast against the tile or background. The 256 px rendering is the reference. The optical
 * variant's SVGs and 16-32 px PNGs are Vixl exports (`python scripts/graphics/build.py logo`).
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const write = process.argv.includes("--write");
export const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL = [16, 24, 32];
const asset = (path) => pathToFileURL(join(root, path)).href;
const VARIANTS = [
  { id: "app-icon-light", label: "App icon, light (supplied)", src: "assets/logo/icons/app-icon-light.svg" },
  { id: "app-icon-dark", label: "App icon, dark (supplied)", src: "assets/logo/icons/app-icon-dark.svg" },
  { id: "app-icon-plum", label: "App icon, plum (supplied)", src: "assets/logo/icons/app-icon-plum.svg" },
  { id: "mark-full-color", label: "Mark on ivory (supplied)", src: "assets/logo/svg/mark-full-color.svg", background: "#F4F1EA" },
  { id: "mark-mono-black", label: "Mark, one colour (supplied)", src: "assets/logo/svg/mark-mono-black.svg", background: "#F4F1EA" },
  { id: "mark-dark", label: "Mark on charcoal (supplied)", src: "assets/logo/dark/mark-dark.svg", background: "#27252B" },
  { id: "png-app-icon-light", label: "Supplied PNG exports", raster: { 16: "assets/logo/icons/app-icon-light-16.png", 32: "assets/logo/icons/app-icon-light-32.png", 48: "assets/logo/icons/app-icon-light-48.png", 64: "assets/logo/icons/app-icon-light-64.png", 128: "assets/logo/icons/app-icon-light-128.png", 256: "assets/logo/icons/app-icon-light-256.png" } },
  ...["light", "dark", "plum"].map((palette) => ({ id: `optical-${palette}`, label: `Optical small variant, ${palette}`, src: `assets/logo/optical/app-icon-${palette}-small.svg`, optical: true })),
];

/** Runs in the page: render one image at one size and measure it from its pixels. */
export function measure({ url, size, background }) {
  const load = (src) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(`Cannot load ${src}`)); image.src = src; });
  return load(url).then((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    if (background) { context.fillStyle = background; context.fillRect(0, 0, size, size); }
    const ratio = Math.min(size / image.naturalWidth, size / image.naturalHeight);
    const width = image.naturalWidth * ratio, height = image.naturalHeight * ratio;
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    const { data } = context.getImageData(0, 0, size, size);
    const pixel = (x, y) => [data[(y * size + x) * 4], data[(y * size + x) * 4 + 1], data[(y * size + x) * 4 + 2]];
    // The tile (or background) colour is what the top-centre of the icon shows.
    const bg = pixel(Math.floor(size / 2), Math.max(1, Math.floor(size * 0.06)));
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const alpha = (x, y) => data[(y * size + x) * 4 + 3];
    const distances = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) distances.push(alpha(x, y) < 128 ? 0 : distance(pixel(x, y), bg));
    const strongest = Math.max(...distances);
    const mask = distances.map((d) => d / strongest >= 0.5);
    // Separate band pieces: 8-connected components of at least two pixels.
    const seen = new Uint8Array(size * size);
    const pieces = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      let count = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const index = stack.pop();
        count++;
        const x = index % size, y = Math.floor(index / size);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const next = ny * size + nx;
          if (mask[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
      if (count >= 2) pieces.push(count);
    }
    // Band width: median horizontal run through the middle rows, corrected for the arms' 20.5 degree slant.
    const runs = [];
    for (let y = Math.floor(size * 0.35); y <= Math.floor(size * 0.6); y++) {
      let run = 0;
      for (let x = 0; x < size; x++) {
        const coverage = distances[y * size + x] / strongest;
        if (coverage > 0.05) run += Math.min(1, coverage);
        else if (run) { runs.push(run); run = 0; }
      }
      if (run) runs.push(run);
    }
    runs.sort((a, b) => a - b);
    const band = runs.length ? runs[Math.floor(runs.length / 2)] * Math.cos((20.5 * Math.PI) / 180) : 0;
    const luminance = (c) => c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    let contrast = 1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (alpha(x, y) < 128) continue;
      const [a, b] = [luminance(pixel(x, y)), luminance(bg)].sort((p, q) => q - p);
      contrast = Math.max(contrast, (a + 0.05) / (b + 0.05));
    }
    return { pieces: pieces.length, bandPx: Math.round(band * 100) / 100, peakContrast: Math.round(contrast * 100) / 100, png: canvas.toDataURL("image/png") };
  });
}

/** Contact sheet: every variant at every size, 1:1, plus 4x nearest-neighbour views of 16-32 px. */
function sheet({ rows, sizes, small }) {
  const load = (src) => new Promise((resolve) => { if (!src) return resolve(null); const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = src; });
  const label = 300, cell = 270, magnified = 4, rowHeight = 300;
  const canvas = document.createElement("canvas");
  canvas.width = label + sizes.reduce((sum, s) => sum + Math.max(s, 40) + 24, 0) + small.reduce((sum, s) => sum + s * magnified + 24, 0) + 24;
  canvas.height = 90 + rows.length * rowHeight;
  const context = canvas.getContext("2d");
  context.fillStyle = "#FCFAF6"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#27252B"; context.font = "600 22px 'Source Sans 3', sans-serif";
  context.fillText("Weft logo at small sizes: rendered 1:1 (left) and 16-32 px magnified 4x (right)", 24, 36);
  context.font = "14px 'Source Sans 3', sans-serif";
  context.fillText("Under each: separate band pieces / band width in px. The crossing reads only while the pieces match the 256 px reference.", 24, 62);
  return Promise.all(rows.map((row) => Promise.all(row.cells.map((c) => load(c.png))))).then((images) => {
    rows.forEach((row, r) => {
      const top = 90 + r * rowHeight;
      context.fillStyle = "#27252B"; context.font = "600 15px 'Source Sans 3', sans-serif";
      context.fillText(row.label, 24, top + 24);
      context.font = "13px 'Source Sans 3', sans-serif"; context.fillStyle = row.verdict.startsWith("Legible") ? "#526D58" : "#9C543D";
      row.verdict.split("\n").forEach((line, i) => context.fillText(line, 24, top + 46 + i * 18));
      let x = label;
      row.cells.forEach((c, i) => {
        if (!c.png) { x += Math.max(c.size, 40) + 24; return; }
        context.imageSmoothingEnabled = false;
        context.drawImage(images[r][i], x, top + 10, c.size, c.size);
        context.fillStyle = c.legible ? "#526D58" : "#9C543D"; context.font = "12px 'Source Sans 3', sans-serif";
        context.fillText(`${c.size}px`, x, top + 10 + Math.min(c.size, cell) + 16);
        context.fillText(`${c.pieces} / ${c.bandPx}`, x, top + 10 + Math.min(c.size, cell) + 32);
        x += Math.max(c.size, 40) + 24;
      });
      row.cells.filter((c) => small.includes(c.size) && c.png).forEach((c) => {
        const image = images[r][row.cells.indexOf(c)];
        context.imageSmoothingEnabled = false;
        context.drawImage(image, x, top + 10, c.size * magnified, c.size * magnified);
        context.fillStyle = "#68616A"; context.fillText(`${c.size}px x4`, x, top + 10 + c.size * magnified + 16);
        x += c.size * magnified + 24;
      });
    });
    return canvas.toDataURL("image/png");
  });
}

/** A Windows/browser icon file holding PNG images. */
export function icoFromPngs(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2); header.writeUInt8(0, entry + 3); header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

// Electron puts its own switches before the script path, so look for this file anywhere in argv.
if (process.argv.slice(1).some((arg) => resolve(arg) === fileURLToPath(import.meta.url))) {
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.whenReady().then(async () => {
    const scratch = mkdtempSync(join(tmpdir(), "weft-logo-"));
    try {
      const page = join(scratch, "logo.html");
      writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:"Source Sans 3";src:url("${asset("assets/fonts/SourceSans3-Regular.woff2")}")}@font-face{font-family:"Source Sans 3";font-weight:600;src:url("${asset("assets/fonts/SourceSans3-Semibold.woff2")}")}</style><body style="font-family:'Source Sans 3'">Weft logo</body>`);
      const window = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true } });
      await window.loadFile(page);
      await window.webContents.executeJavaScript("document.fonts.load(\"600 16px 'Source Sans 3'\").then(() => document.fonts.load(\"16px 'Source Sans 3'\")).then(() => true)");
      const run = (fn, arg) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`);
      const results = [];
      for (const variant of VARIANTS) {
        const cells = [];
        for (const size of SIZES) {
          const src = variant.raster ? variant.raster[size] : variant.src;
          if (!src) { cells.push({ size, pieces: null, bandPx: null, peakContrast: null, png: null }); continue; }
          cells.push({ size, ...(await run(measure, { url: asset(src), size, background: variant.background })) });
        }
        const reference = cells.find((c) => c.size === 256 && c.pieces !== null)?.pieces;
        for (const c of cells) c.legible = c.pieces === null ? null : c.pieces === reference && c.bandPx >= 1.5;
        const lost = cells.filter((c) => c.legible === false).map((c) => c.size);
        const verdict = lost.length ? `Crossing or bands lost at ${lost.join(", ")} px` : "Legible at every rendered size";
        results.push({ id: variant.id, label: variant.label, optical: Boolean(variant.optical), reference, verdict, cells });
      }
      const summary = results.map(({ cells, ...rest }) => ({ ...rest, cells: cells.map(({ png, ...metrics }) => metrics) }));
      const opticalOk = summary.filter((r) => r.optical).every((r) => r.cells.filter((c) => SMALL.includes(c.size)).every((c) => c.legible));
      const suppliedLost = summary.filter((r) => !r.optical && r.id.startsWith("app-icon")).some((r) => r.cells.some((c) => SMALL.includes(c.size) && c.legible === false));
      const report = { generatedBy: "scripts/validate-logo.js", sizes: SIZES, smallSizes: SMALL, decision: suppliedLost ? (opticalOk ? "adopt-optical-variant-for-16-32" : "optical-variant-insufficient") : "supplied-variants-sufficient", opticalOk, suppliedLost, results: summary };
      console.log(`WEFT_LOGO ${JSON.stringify(report)}`);
      if (write) {
        mkdirSync(join(root, "artifacts"), { recursive: true });
        writeFileSync(join(root, "artifacts/logo-validation.json"), JSON.stringify(report, null, 2) + "\n");
        const rows = results.map((r) => ({ label: r.label, verdict: `${r.verdict}\nreference: ${r.reference} pieces at 256 px`, cells: r.cells }));
        const contact = await run(sheet, { rows, sizes: SIZES, small: SMALL });
        writeFileSync(join(root, "artifacts/logo-contact-sheet.png"), Buffer.from(contact.split(",")[1], "base64"));
        // favicon.ico: the optical variant where the supplied mark loses its crossing, the supplied export above that.
        const optical = (size) => readFileSync(join(root, `assets/logo/optical/app-icon-light-small-${size}.png`));
        writeFileSync(join(root, "assets/logo/icons/favicon.ico"), icoFromPngs([...SMALL.map((size) => ({ size, png: optical(size) })), { size: 48, png: readFileSync(join(root, "assets/logo/icons/app-icon-light-48.png")) }]));
      }
      app.exit(report.decision === "optical-variant-insufficient" ? 1 : 0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
