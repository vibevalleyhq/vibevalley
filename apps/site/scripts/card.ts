import sharp from "sharp";

import type { Copy } from "../src/i18n/zh";

const W = 1200;
const H = 630;
const LEFT = 72;
// Papertrails editorial palette aligned with src/ui/global.css.
const CREAM = "#f7f1e2";
const WHEAT = "#f6ce6c";
const AMBER = "#e5a93c";
const INK = "#2f1f13";

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Rough advance width estimate for wrapping editorial copy cleanly across CJK and Latin scripts. */
function measure(text: string, size: number): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? size * 1.02 : size * 0.56;
  return width;
}

function wrap(text: string, size: number, max: number): string[] {
  const lines: string[] = [];
  let last = "";
  for (const part of text.match(/[\w'.,;:!?-]+ ?|\S ?/gu) ?? []) {
    const next = last + part;
    if (last && !/^[，。、；：！？,.;:!?]/u.test(part) && measure(next.trimEnd(), size) > max) {
      lines.push(last.trim());
      last = part;
    } else last = next;
  }
  if (last.trim()) lines.push(last.trim());
  return lines;
}

export async function drawCard(copy: Copy, background: string, iconPath: string) {
  const { hero } = copy;
  const lead = wrap(hero.lead, 24, 540);
  const displayFont = "'Songti SC', 'STSong', 'Noto Serif CJK SC', Georgia, serif";
  const sansFont = "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', -apple-system, sans-serif";
  const monoFont = "'Maple Mono NF CN', Menlo, Monaco, monospace";

  const leadMarkup = lead
    .map(
      (line, index) =>
        `<text x="${LEFT}" y="${418 + index * 36}" font-family="${sansFont}" font-size="24" font-weight="500" fill="${CREAM}" opacity="0.94" filter="url(#shadow)">${escapeXml(line)}</text>`,
    )
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="shade" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="${INK}" stop-opacity="0.86"/>
        <stop offset="0.48" stop-color="${INK}" stop-opacity="0.54"/>
        <stop offset="0.82" stop-color="${INK}" stop-opacity="0.06"/>
      </linearGradient>
      <filter id="shadow" x="-10%" y="-10%" width="130%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="${INK}" flood-opacity="0.65"/>
      </filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>
    <rect x="${LEFT}" y="66" width="56" height="4" rx="2" fill="${AMBER}"/>
    <text x="${LEFT + 72}" y="76" font-family="${sansFont}" font-size="22" font-weight="600" letter-spacing="1.5" fill="${WHEAT}" filter="url(#shadow)">${escapeXml(hero.aka)}</text>
    <text x="${LEFT}" y="220" font-family="${displayFont}" font-size="84" font-weight="700" fill="${CREAM}" filter="url(#shadow)">${escapeXml(hero.name)}</text>
    <text x="${LEFT}" y="318" font-family="${displayFont}" font-size="42" font-weight="700" fill="${WHEAT}" filter="url(#shadow)">${escapeXml(hero.tagline)}</text>
    ${leadMarkup}
    <text x="${LEFT + 54}" y="${H - 54}" font-family="${monoFont}" font-size="22" font-weight="500" fill="${CREAM}" opacity="0.9" filter="url(#shadow)">vibevalley.dev</text>
  </svg>`;

  const icon = await sharp(iconPath).resize(40, 40).png().toBuffer();

  return sharp(background)
    .resize(W, H, { fit: "cover", position: "right" })
    .composite([{ input: Buffer.from(svg) }, { input: icon, left: LEFT, top: H - 82 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
