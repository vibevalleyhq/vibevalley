/**
 * The share card (og:image) for a language: the farm at dusk, cropped to 1200×630, with the hero's words on a shade
 * at the left, as the page's first screen has them. The words are the pixel font's glyphs turned into SVG paths
 * (opentype.js), so drawing them needs no font installed: sharp's own text goes through fontconfig, which does not
 * pick up a font file it is handed.
 */

import opentype from 'opentype.js'
import sharp from 'sharp'
import type { Copy } from '../src/i18n/zh'

const W = 1200
const H = 630
const LEFT = 72
// The font is drawn on a 12px grid: sizes are multiples of 12 so its pixels land on whole pixels.
const NAME = 96
const AKA = 24
const TAGLINE = 48
const LEAD = 24
// global.css: cream-50, wheat, bark-900.
const CREAM = '#f7e8c4'
const WHEAT = '#e5a93c'
const INK = '#2f1f13'

export async function drawCard(copy: Copy, fontFile: Uint8Array, background: string) {
  const font = opentype.parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength) as ArrayBuffer)
  const width = (text: string, size: number) => font.getAdvanceWidth(text, size)
  // Each line's glyphs as one path, with a hard drop shadow the colour of ink (text-shadow-ink, -title).
  const line = (text: string, size: number, y: number, fill: string, shadow: number) => {
    const d = font.getPath(text, LEFT, y, size).toPathData(2)
    const drop = font.getPath(text, LEFT + shadow, y + shadow, size).toPathData(2)
    return `<path d="${drop}" fill="${INK}"/><path d="${d}" fill="${fill}"/>`
  }

  const { hero } = copy
  const lead = wrap(hero.lead, LEAD, 560, width)
  let y = 210
  const parts = [line(hero.name, NAME, y, CREAM, 6)]
  y += 48
  parts.push(line(hero.aka, AKA, y, WHEAT, 2))
  y += 96
  parts.push(line(hero.tagline, TAGLINE, y, WHEAT, 3))
  y += 24
  for (const l of lead) parts.push(line(l, LEAD, (y += 36), CREAM, 2))
  parts.push(line('vibevalley.dev', LEAD, H - 56, CREAM, 2))

  // The hero's shade: dark at the left, gone by the middle (Hero.tsx, md:bg-linear-90).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
    <defs><linearGradient id="shade" x1="0" x2="1"><stop offset="0" stop-color="#1e140a" stop-opacity="0.78"/><stop offset="0.5" stop-color="#1e140a" stop-opacity="0.35"/><stop offset="0.8" stop-color="#1e140a" stop-opacity="0"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>
    ${parts.join('\n')}
  </svg>`

  return sharp(background)
    .resize(W, H, { fit: 'cover', position: 'right' })
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()
}

/** Lines of at most `max` wide, broken between words or between Chinese characters, never before a punctuation mark. */
function wrap(text: string, size: number, max: number, width: (text: string, size: number) => number) {
  const lines = ['']
  for (const p of text.match(/[\w'.,;:!?-]+ ?|\S ?/gu) ?? []) {
    const next = lines.at(-1)! + p
    if (lines.at(-1) && !/^[，。、；：！？,.;:!?]/u.test(p) && width(next.trimEnd(), size) > max) lines.push(p)
    else lines[lines.length - 1] = next
  }
  return lines.map((l) => l.trim())
}
