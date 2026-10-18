import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Turns the Vixl SVG exports in assets/graphics (built by scripts/graphics/build.py) into
 * src/icons.js: the editable document, ids and identity transforms are dropped, numbers are
 * rounded and colours become theme-aware. Charcoal becomes `currentColor`, so an icon takes
 * its control's colour; any other token colour becomes a class (`f-brand`, `s-sage`) that
 * gui.css paints with that token, so illustrations follow the light and dark themes. A colour
 * outside the light palette, or anything but vector shapes, is an error.
 */
const graphics = new URL("../assets/graphics/", import.meta.url);
const SETS = { icons: "icons", states: "states", illustrations: "illustrations" };
const ELEMENTS = new Set(["svg", "g", "path", "rect", "ellipse", "circle"]);
const DROP = new Set(["data-layer", "data-vixl-id", "preserveAspectRatio", "overflow", "xmlns"]);

function parse(text) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const body = text.replace(/<\?xml[^>]*\?>/, "").replace(/<metadata[\s\S]*?<\/metadata>/g, "").replace(/<defs\s*\/>/g, "");
  for (const [, close, name, attrs, self, rest] of body.matchAll(/<(\/?)([\w-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (rest !== undefined) {
      if (rest.trim()) throw new Error(`unexpected text ${JSON.stringify(rest.trim().slice(0, 40))}`);
      continue;
    }
    if (close) {
      if (stack.pop().name !== name) throw new Error(`mismatched </${name}>`);
      continue;
    }
    if (!ELEMENTS.has(name)) throw new Error(`<${name}> is not a vector shape; simplify the Vixl document`);
    const node = { name, attrs: Object.fromEntries([...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])), children: [] };
    stack.at(-1).children.push(node);
    if (!self) stack.push(node);
  }
  const [svg] = root.children;
  if (root.children.length !== 1 || svg.name !== "svg") throw new Error("expected one <svg> root");
  return svg;
}

const round = (value) => String(Number(Number(value).toFixed(2)));
const numbers = (text) => text.replace(/-?\d*\.?\d+(?:e-?\d+)?/gi, round);
const hex = (rgb) => "#" + rgb.match(/\d+/g).map((v) => Number(v).toString(16).padStart(2, "0")).join("");

function palette() {
  const tokens = JSON.parse(readFileSync(new URL("../assets/tokens.json", import.meta.url), "utf8"));
  const names = new Map();
  for (const [name, value] of Object.entries(tokens.themes.light)) if (/^#[\da-f]{6}$/i.test(value) && !names.has(value.toLowerCase())) names.set(value.toLowerCase(), name);
  return names;
}

// Vixl writes each layer as translate(centre) rotate scale translate(-pivot); unrotated, unscaled ones collapse.
function transform(value) {
  const match = value.match(/^translate\(([-\d.e]+) ([-\d.e]+)\) rotate\(0\) scale\(1 1\) translate\(([-\d.e]+) ([-\d.e]+)\)$/);
  if (!match) return numbers(value);
  const [x, y] = [Number(match[1]) + Number(match[3]), Number(match[2]) + Number(match[4])].map(round);
  return x === "0" && y === "0" ? "" : `translate(${x} ${y})`;
}

function clean(node, colors, file) {
  const attrs = {};
  const classes = [];
  for (const [key, value] of Object.entries(node.attrs)) {
    if (DROP.has(key) || (key === "opacity" && Number(value) === 1)) continue;
    attrs[key] = value;
  }
  for (const paint of ["fill", "stroke"]) {
    const opacity = attrs[`${paint}-opacity`];
    delete attrs[`${paint}-opacity`];
    if (!(paint in attrs)) continue;
    if (opacity !== undefined && Number(opacity) === 0) {
      if (paint === "fill") attrs.fill = "none";
      else for (const key of Object.keys(attrs)) if (key.startsWith("stroke")) delete attrs[key];
      continue;
    }
    if (opacity !== undefined && Number(opacity) !== 1) attrs[`${paint}-opacity`] = round(opacity);
    if (!attrs[paint].startsWith("rgb(")) continue;
    const color = hex(attrs[paint]);
    const token = colors.get(color);
    if (!token) throw new Error(`${file}: ${color} is not a light-theme token colour`);
    if (token === "ink") attrs[paint] = "currentColor";
    else {
      delete attrs[paint];
      classes.push(`${paint[0]}-${token}`);
    }
  }
  if (attrs.transform !== undefined) attrs.transform = transform(attrs.transform);
  if (!attrs.transform) delete attrs.transform;
  for (const key of ["d", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "stroke-width"]) if (key in attrs) attrs[key] = numbers(attrs[key]);
  if (classes.length) attrs.class = classes.join(" ");
  let { name } = node;
  if (name === "svg") {
    // A nested <svg> is a path's coordinate frame: a group, scaled when its viewBox differs from its size.
    const [, , vw, vh] = (attrs.viewBox || `0 0 ${attrs.width} ${attrs.height}`).split(/\s+/).map(Number);
    const [sx, sy] = [Number(attrs.width) / vw, Number(attrs.height) / vh].map(round);
    for (const key of ["viewBox", "width", "height"]) delete attrs[key];
    if (sx !== "1" || sy !== "1") attrs.transform = `scale(${sx} ${sy})`;
    name = "g";
  }
  const children = node.children.flatMap((child) => clean(child, colors, file));
  if (name === "g" && !Object.keys(attrs).length) return children;
  if (name === "g" && !children.length) return [];
  const open = `<${name}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("")}`;
  return [children.length ? `${open}>${children.join("")}</${name}>` : `${open}/>`];
}

export function renderIcons() {
  const colors = palette();
  const sets = {};
  for (const [key, folder] of Object.entries(SETS)) {
    sets[key] = {};
    for (const file of readdirSync(new URL(folder + "/", graphics)).filter((f) => f.endsWith(".svg")).sort()) {
      const svg = parse(readFileSync(new URL(`${folder}/${file}`, graphics), "utf8"));
      sets[key][file.slice(0, -4)] = { viewBox: numbers(svg.attrs.viewBox), body: svg.children.flatMap((child) => clean(child, colors, file)).join("") };
    }
  }
  const table = (set) => `{\n${Object.entries(set).map(([name, { body }]) => `  ${JSON.stringify(name)}: ${JSON.stringify(body)},`).join("\n")}\n}`;
  const box = (set) => [...new Set(Object.values(set).map((entry) => entry.viewBox))];
  for (const [key, set] of Object.entries(sets)) if (box(set).length > 1) throw new Error(`${key} must share one canvas size`);
  return `/* Generated by node scripts/generate-icons.js from the Vixl exports in assets/graphics. Do not edit. */
const icons = ${table(sets.icons)};
const states = ${table(sets.states)};
const illustrations = ${table(sets.illustrations)};
export const iconNames = Object.keys(icons);
export const illustrationNames = Object.keys(illustrations);
export const icon = (name) =>
  \`<svg viewBox="${box(sets.icons)[0]}" aria-hidden="true">\${icons[name] || icons.file}</svg>\`;
/** A state badge's marker: one distinct shape per state, coloured by its badge (style guide 10). */
export const stateMarker = (name) =>
  \`<svg class="state-marker" viewBox="${box(sets.states)[0]}" aria-hidden="true">\${states[name] || states.available}</svg>\`;
/** A decorative spot illustration for an empty state, or "" when there is none for this name. */
export const illustration = (name) =>
  illustrations[name] ? \`<svg class="illustration" viewBox="${box(sets.illustrations)[0]}" aria-hidden="true">\${illustrations[name]}</svg>\` : "";
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(new URL("../src/icons.js", import.meta.url), renderIcons());
