import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderTokens } from "../scripts/generate-tokens.js";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = JSON.parse(read("../assets/tokens.json"));
test("generated theme CSS matches the canonical design tokens", () => {
  assert.equal(read("../assets/tokens.css"), renderTokens(tokens));
  const css = read("../src/gui.css");
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i, "colors belong in tokens.json");
  const known = new Set([...Object.keys(tokens.common), ...Object.keys(tokens.themes.light)]);
  for (const [,name] of css.matchAll(/var\(--([\w-]+)/g)) assert.ok(known.has(name), `undefined token ${name}`);
  assert.deepEqual(Object.keys(tokens.themes.light), Object.keys(tokens.themes.dark));
  assert.equal(tokens.reducedMotion["motion-fast"], "0ms");
});
const luminance = color => {
  const rgb = color.replace('#', '').match(/../g).map(x => parseInt(x,16)/255).map(x => x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4);
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
};
test("production text and status colors meet 4.5:1 in both themes", () => {
  for (const [name,t] of Object.entries(tokens.themes)) {
    for (const [fg,bg] of [['ink','surface'],['muted','surface'],['muted','canvas'],['brand','brand-soft'],['sage','sage-soft'],['clay','clay-soft'],['danger','surface'],['surface','brand'],['avatar-ink','avatar-background']]) {
      const [a,b] = [luminance(t[fg]), luminance(t[bg])].sort((a,b)=>b-a);
      assert.ok((a+.05)/(b+.05)>=4.5, `${name} ${fg}/${bg} contrast ${(a+.05)/(b+.05)}`);
    }
  }
});
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
test("state, hover, trusted-surface and focus tokens keep their contrast in both themes (#31, #36)", () => {
  for (const [name, t] of Object.entries(tokens.themes)) {
    // Secondary text stays readable on every surface it appears on, including hover and selection.
    for (const bg of ["surface", "canvas", "white", "hover", "rail", "brand-soft", "sage-soft", "clay-soft"]) assert.ok(ratio(t.muted, t[bg]) >= 4.5, `${name} muted/${bg} ${ratio(t.muted, t[bg])}`);
    for (const [fg, bg, min] of [["trusted-ink", "trusted-surface", 4.5], ["ink", "trusted-surface", 4.5], ["disabled-ink", "disabled-surface", 3], ["disabled-ink", "surface", 3], ["disabled-ink", "canvas", 3],
      ["focus-ring", "surface", 3], ["focus-ring", "canvas", 3], ["focus-ring", "white", 3], ["control-border", "white", 3], ["control-border", "surface", 3], ["brand", "hover", 4.5]])
      assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg}/${bg} ${ratio(t[fg], t[bg])}`);
  }
});
test("production scales: an 11 px type floor and consolidated spacing and radius steps (#36)", () => {
  const px = (value) => value.endsWith("rem") ? parseFloat(value) * 16 : parseFloat(value);
  const scale = (prefix) => Object.entries(tokens.common).filter(([key]) => key.startsWith(prefix)).map(([, value]) => px(value)).sort((a, b) => a - b);
  assert.ok(Math.min(...scale("font-size-")) >= 11);
  assert.deepEqual(scale("space-"), [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40]);
  assert.deepEqual(scale("radius-"), [4, 6, 8, 12]);
  for (const [key, value] of Object.entries(tokens.common)) if (/^(space|radius|font-size)-(\d+)$/.test(key)) assert.equal(px(value), Number(key.split("-").at(-1)), `${key} is named after its pixel value`);
});
