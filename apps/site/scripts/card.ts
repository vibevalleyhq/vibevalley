import { createRequire } from "node:module";

import type * as OpenType from "opentype.js";
import sharp from "sharp";

import type { Copy } from "../src/i18n/zh";

const require = createRequire(import.meta.url);
const opentype: typeof OpenType = require("opentype.js");

const W = 1200;
const H = 630;
const LEFT = 72;
// The font is drawn on a 12px grid: sizes are multiples of 12 so its pixels land on whole pixels.
const NAME = 96;
const AKA = 24;
const TAGLINE = 48;
const LEAD = 24;
// global.css: cream-50, wheat, bark-900.
const CREAM = "#f7e8c4";
const WHEAT = "#e5a93c";
const INK = "#2f1f13";

export async function drawCard(copy: Copy, fontFile: Uint8Array, background: string) {
  const font = opentype.parse(new Uint8Array(fontFile).buffer);
  const width = (text: string, size: number) => font.getAdvanceWidth(text, size);
  const line = (text: string, size: number, y: number, fill: string, shadow: number) => {
    const d = font.getPath(text, LEFT, y, size).toPathData(2);
    const drop = font.getPath(text, LEFT + shadow, y + shadow, size).toPathData(2);
    return `<path d="${drop}" fill="${INK}"/><path d="${d}" fill="${fill}"/>`;
  };

  const { hero } = copy;
  const lead = wrap(hero.lead, LEAD, 560, width);
  let y = 210;
  const parts = [line(hero.name, NAME, y, CREAM, 6)];
  y += 48;
  parts.push(line(hero.aka, AKA, y, WHEAT, 2));
  y += 96;
  parts.push(line(hero.tagline, TAGLINE, y, WHEAT, 3));
  y += 24;
  for (const l of lead) parts.push(line(l, LEAD, (y += 36), CREAM, 2));
  parts.push(line("vibevalley.dev", LEAD, H - 56, CREAM, 2));

  // Keep this shade aligned with Hero.tsx.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
    <defs><linearGradient id="shade" x1="0" x2="1"><stop offset="0" stop-color="#1e140a" stop-opacity="0.78"/><stop offset="0.5" stop-color="#1e140a" stop-opacity="0.35"/><stop offset="0.8" stop-color="#1e140a" stop-opacity="0"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>
    ${parts.join("\n")}
  </svg>`;

  return sharp(background)
    .resize(W, H, { fit: "cover", position: "right" })
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/** Lines of at most `max` wide, broken between words or between Chinese characters, never before a punctuation mark. */
function wrap(text: string, size: number, max: number, width: (text: string, size: number) => number) {
  const lines: string[] = [];
  let last = "";
  for (const p of text.match(/[\w'.,;:!?-]+ ?|\S ?/gu) ?? []) {
    const next = last + p;
    if (last && !/^[，。、；：！？,.;:!?]/u.test(p) && width(next.trimEnd(), size) > max) {
      lines.push(last.trim());
      last = p;
    } else last = next;
  }
  lines.push(last.trim());
  return lines;
}
