import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Small-size optical variant of the Weft app icon (#36), generated deterministically.
 *
 * It keeps the supplied mark's geometry: the same two band centrelines (the "under" V
 * on the left, the "over" V on the right, crossing once) in the same place on the same
 * rounded tile. Only the parts that disappear at favicon sizes change: the bands are
 * thicker, the mark fills more of the tile and the over-under cut is wide enough to survive
 * rasterisation at 16-32 px (scripts/validate-logo.js measures this). Edit the numbers here, then run
 * `node scripts/logo-optical.js` and `npm run logo:validate -- --write`.
 */
export const OPTICAL = { bandPx: 1.75, gapPx: 1.25, markScale: 1.25, tile: 16 };
// Band centrelines of the supplied mark, in its 512-unit drawing (from assets/logo/svg/mark-full-color.svg).
const UNDER = [[92, 155], [190, 417], [313, 89]];
const OVER = [[199, 89], [322, 417], [420, 155]];
// Placement of the mark on the 1024-unit app-icon tile (from assets/logo/icons/app-icon-light.svg).
const PLACE = { scale: 1.45, x: 140.8, y: 130.65, radius: 224 };
export const PALETTES = {
  light: { tile: "#F4F1EA", over: "#70516F", under: "#718676" },
  dark: { tile: "#27252B", over: "#CDA9CB", under: "#A3B8A8" },
  plum: { tile: "#70516F", over: "#F4F1EA", under: "#C9D3CB" },
};

const round = (value) => Number(value.toFixed(3));
// markScale enlarges the mark about the tile centre: small tiles have less margin to spare.
const toTile = ([x, y], size, markScale = 1) => [(PLACE.x + PLACE.scale * x) / 1024, (PLACE.y + PLACE.scale * y) / 1024].map((v) => round((0.5 + (v - 0.5) * markScale) * size));
const points = (list, size, markScale) => list.map((point) => toTile(point, size, markScale).join(",")).join(" ");

/** SVG for one palette, drawn on a `tile`-unit grid so 1 unit is 1 pixel at the reference size. */
export function opticalSvg(palette, { bandPx = OPTICAL.bandPx, gapPx = OPTICAL.gapPx, tile = OPTICAL.tile, markScale = OPTICAL.markScale ?? 1 } = {}) {
  const colors = PALETTES[palette];
  if (!colors) throw new Error(`Unknown palette ${palette}`);
  const radius = round((PLACE.radius / 1024) * tile);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}" viewBox="0 0 ${tile} ${tile}">`
    + `<title>Weft</title>`
    + `<rect width="${tile}" height="${tile}" rx="${radius}" fill="${colors.tile}"/>`
    + `<polyline points="${points(UNDER, tile, markScale)}" fill="none" stroke="${colors.under}" stroke-width="${bandPx}" stroke-linejoin="round" stroke-linecap="butt"/>`
    // The over-under cut: a tile-coloured band, wider than the over band, separates the crossing.
    + `<polyline points="${points(OVER.slice(0, 2), tile, markScale)}" fill="none" stroke="${colors.tile}" stroke-width="${bandPx + 2 * gapPx}" stroke-linecap="butt"/>`
    + `<polyline points="${points(OVER, tile, markScale)}" fill="none" stroke="${colors.over}" stroke-width="${bandPx}" stroke-linejoin="round" stroke-linecap="butt"/>`
    + `</svg>\n`;
}

export const opticalFiles = () => Object.keys(PALETTES).map((palette) => [`assets/logo/optical/app-icon-${palette}-small.svg`, opticalSvg(palette)]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  mkdirSync(new URL("assets/logo/optical/", root), { recursive: true });
  for (const [path, svg] of opticalFiles()) writeFileSync(new URL(path, root), svg);
}
