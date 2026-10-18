import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { electronEnv } from "../scripts/electron-env.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));

test("optical small-size icons are Vixl exports with their editable masters", () => {
  for (const palette of ["light", "dark", "plum"]) {
    assert.match(read(`assets/logo/optical/app-icon-${palette}-small.svg`).toString("utf8"), /<metadata id="vixl-document">/);
    assert.ok(read(`assets/logo/source/app-icon-${palette}-small.vixl`).length > 0);
  }
});

test("favicon.ico carries the optical variant at 16-32 px and the supplied export at 48 px", () => {
  const ico = read("assets/logo/icons/favicon.ico");
  assert.equal(ico.readUInt16LE(2), 1);
  const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const at = 6 + i * 16;
    const png = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    return { size: ico.readUInt8(at), width: png.readUInt32BE(16), png };
  });
  assert.deepEqual(entries.map((e) => [e.size, e.width]), [[16, 16], [24, 24], [32, 32], [48, 48]]);
  for (const size of [16, 24, 32]) assert.deepEqual(entries.find((e) => e.size === size).png, read(`assets/logo/optical/app-icon-light-small-${size}.png`));
  assert.deepEqual(entries.find((e) => e.size === 48).png, read("assets/logo/icons/app-icon-light-48.png"));
  const report = JSON.parse(read("artifacts/logo-validation.json"));
  assert.equal(report.decision, "adopt-optical-variant-for-16-32");
});

test("rendered measurements: the supplied mark loses its crossing at favicon sizes; the optical variant keeps it", {
  timeout: 120000,
  skip: process.platform !== "linux" ? "Measured with the Linux Chromium job" : !process.env.DISPLAY ? "Requires DISPLAY or xvfb-run" : false,
}, async () => {
  const child = spawn(electron, ["--no-sandbox", "--disable-gpu", fileURLToPath(new URL("scripts/validate-logo.js", root))], { env: electronEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (x) => (output += x));
  child.stderr.on("data", (x) => (output += x));
  const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  assert.equal(code, 0, output.slice(-3000));
  const report = JSON.parse(/WEFT_LOGO (.*)/.exec(output)[1]);
  const cell = (id, size) => report.results.find((r) => r.id === id).cells.find((c) => c.size === size);
  assert.equal(report.decision, "adopt-optical-variant-for-16-32");
  // Supplied tile icons: three band pieces at 256 px merge into fewer at 16 px (the over-under crossing disappears).
  for (const id of ["app-icon-light", "app-icon-dark", "app-icon-plum"]) {
    assert.equal(cell(id, 256).pieces, 3);
    assert.ok(cell(id, 16).pieces < 3, `${id} keeps its crossing at 16 px`);
  }
  for (const palette of ["light", "dark", "plum"]) for (const size of [16, 24, 32]) {
    const measured = cell(`optical-${palette}`, size);
    assert.equal(measured.pieces, 3, `optical ${palette} ${size}px`);
    assert.ok(measured.bandPx >= 1.5, `optical ${palette} ${size}px band ${measured.bandPx}`);
    assert.ok(measured.peakContrast >= 3, `optical ${palette} ${size}px contrast ${measured.peakContrast}`);
  }
});
