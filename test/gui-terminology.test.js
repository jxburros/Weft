import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Style guide 3 (#36): ordinary interface labels carry the product; the weaving metaphor stays in the
 * logo and a few brand details. "Workspaces" is the provisional name until a human decides between
 * Workspaces, Desks and Hubs, so no other name for a project space may appear.
 */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const guiFiles = ["src/gui.html", "src/credential-entry.html", ...readdirSync(new URL("../src", import.meta.url)).filter((name) => /^gui.*\.js$/.test(name)).map((name) => `src/${name}`)];
// Visible strings only: text between tags and double-quoted string literals (labels, toasts, options).
const visibleText = (source) => [...source.matchAll(/>([^<>{}`]+)</g), ...source.matchAll(/"([^"\n]{2,})"/g)].map((m) => m[1]).join("\n");

test("workspace sections use the guide's familiar labels", () => {
  const gui = read("src/gui.js");
  const sections = [.../const sections = \[([^\]]+)\]/.exec(gui)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const names = Object.fromEntries([.../const names = \{([^}]+)\}/.exec(gui)[1].matchAll(/(\w+): "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(sections.map((key) => names[key]), ["Overview", "Materials", "Context", "Tasks", "Conversations", "Artifacts", "Activity"]);
});

test("no textile vocabulary replaces navigation, and project spaces are called workspaces", () => {
  for (const file of guiFiles) {
    const text = visibleText(read(file));
    assert.doesNotMatch(text, /\b(looms?|tapestr(y|ies)|shuttles?|warp|spindles?|bobbins?|skeins?|threads?|weav(e|es|ing)|fabrics?|textiles?)\b/i, `${file} uses textile vocabulary for interface concepts`);
    assert.doesNotMatch(text, /\bhubs?\b/i, `${file} names project spaces something other than Workspaces`);
    // "Woven" appears only in the brand tagline.
    const woven = text.match(/woven/gi) || [];
    for (const line of text.split("\n").filter((line) => /woven/i.test(line))) assert.match(line, /your work, woven together/i, `${file}: "woven" outside the brand tagline`);
    assert.ok(woven.length <= 2, `${file} repeats the woven tagline`);
  }
  // "Desk" never names a project space: only the command desk (a developer tool) and the empty-task line "A clear desk".
  for (const file of guiFiles) for (const match of visibleText(read(file)).matchAll(/.{0,16}(?<![-\w])desks?(?![-\w])/gi)) assert.match(match[0], /command\s+desk|a clear desk/i, `${file}: "${match[0]}"`);
});
