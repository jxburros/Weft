import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderIcons } from "../scripts/generate-icons.js";
import { iconNames, illustrationNames, icon, illustration, stateMarker } from "../src/icons.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sources = readdirSync(new URL("../src/", import.meta.url)).filter((file) => /^gui.*\.js$/.test(file)).map((file) => read(`../src/${file}`)).join("\n");

test("src/icons.js is generated from the Vixl exports in assets/graphics", () => {
  assert.equal(read("../src/icons.js"), renderIcons());
});

test("every icon the interface names is drawn, and drawings carry no raster or foreign colour", () => {
  for (const [, name] of sources.matchAll(/\bicon\("([\w-]+)"\)/g)) assert.ok(iconNames.includes(name), `missing icon ${name}`);
  // Names also reach icon() through action(), section tables and records, so none of the set may go missing.
  for (const name of ["activity", "arrow", "artifacts", "back", "bookmark", "chat", "check", "chevron", "clock", "close", "context",
    "download", "external", "file", "folder", "globe", "grid", "home", "lock", "moon", "more", "note", "pause", "pin", "play", "plus",
    "reload", "search", "settings", "shield", "sidebar", "spark", "split", "stop", "sun", "tabs", "tasks", "terminal", "trash", "upload",
    "workflow"]) assert.ok(iconNames.includes(name), `missing icon ${name}`);
  const markup = [...iconNames.map(icon), ...illustrationNames.map(illustration), stateMarker("working")].join("");
  assert.doesNotMatch(markup, /<(image|text|use|foreignObject)\b|rgb\(|#[\da-f]{6}/i);
  // Icons take their control's colour; illustrations paint with theme tokens through classes gui.css defines.
  assert.doesNotMatch(iconNames.map(icon).join(""), /class="/);
  const css = read("../src/gui.css");
  for (const [, name] of markup.matchAll(/class="([^"]+)"/g)) for (const token of name.split(" ").filter((c) => /^[fs]-/.test(c)))
    assert.match(css, new RegExp(`\\.${token} \\{ (fill|stroke): var\\(--${token.slice(2)}\\); \\}`), `no paint rule for ${token}`);
  assert.equal(icon("no-such-icon"), icon("file"));
  assert.equal(illustration("no-such-illustration"), "");
});

test("each state badge has its own Vixl marker shape", () => {
  const shapes = ["working", "waiting", "paused", "done", "blocked", "agent", "you", "assist", "available"];
  const drawn = shapes.map(stateMarker);
  assert.equal(new Set(drawn).size, shapes.length);
  for (const marker of drawn) assert.match(marker, /^<svg class="state-marker" viewBox="0 0 12 12" aria-hidden="true">/);
});

const webpPlays = (path) => {
  const data = readFileSync(new URL(path, import.meta.url));
  const at = data.indexOf("ANIM");
  assert.ok(at > 0, `${path} is not an animated WebP`);
  return data.readUInt16LE(at + 12);
};

test("motion assets exist for both themes with a reduced-motion still, and the identity moment plays once", () => {
  for (const [, name] of sources.matchAll(/motionArt\("([\w-]+)"/g)) for (const theme of ["light", "dark"]) {
    assert.ok(existsSync(new URL(`../assets/graphics/motion/${name}-${theme}.webp`, import.meta.url)), `${name}-${theme}.webp`);
    assert.ok(existsSync(new URL(`../assets/graphics/motion/${name}-${theme}-still.svg`, import.meta.url)), `${name}-${theme}-still.svg`);
    assert.ok(existsSync(new URL(`../assets/graphics/source/${name}-${theme}.vixl`, import.meta.url)), `${name}-${theme}.vixl`);
  }
  // Style guide 11: woven movement is an occasional identity moment, never a background loop.
  for (const theme of ["light", "dark"]) {
    assert.equal(webpPlays(`../assets/graphics/motion/mark-in-${theme}.webp`), 1);
    assert.equal(webpPlays(`../assets/graphics/motion/waiting-dots-${theme}.webp`), 0);
  }
  assert.match(read("../src/gui.css"), /prefers-reduced-motion: reduce[\s\S]*animation: none !important/);
});

test("packaged builds include every asset the interface loads", () => {
  const { files } = createRequire(import.meta.url)("../electron-builder.config.cjs");
  const gui = sources + read("../src/gui.html") + read("../src/gui.css");
  const referenced = new Set();
  for (const [, path] of gui.matchAll(/\.\.\/(assets\/[\w./@-]+)/g)) {
    if (path.includes("${")) continue;
    referenced.add(path);
  }
  for (const [, name] of sources.matchAll(/motionArt\("([\w-]+)"/g)) for (const theme of ["light", "dark"])
    for (const file of [`${name}-${theme}.webp`, `${name}-${theme}-still.svg`]) referenced.add(`assets/graphics/motion/${file}`);
  const packaged = (path) => files.some((pattern) => pattern.endsWith("/**/*") ? path.startsWith(pattern.slice(0, -4)) : pattern === path);
  assert.ok(referenced.size > 5);
  for (const path of referenced) assert.ok(packaged(path), `${path} is not in electron-builder files`);
});
