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
