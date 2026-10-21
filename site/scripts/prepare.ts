/**
 * What the pages take from the game before a build, into public/gen/ (not kept in git): the pixel font cut down to
 * the characters the pages use (the whole font is 5 MB of Chinese; the pages use a few hundred characters), and the
 * app's icon for the tab and the home screen, the font's licence, and each language's share card (card.ts). Runs before `astro check` and `astro build` (package.json).
 */

import { Glob } from 'bun'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import subsetFont from 'subset-font'
import { en } from '../src/i18n/en'
import { zh } from '../src/i18n/zh'
import { drawCard } from './card'

const site = resolve(import.meta.dir, '..')
const pub = resolve(site, '../apps/web/public')
const out = resolve(site, 'public/gen')
mkdirSync(out, { recursive: true })

// Every character in the pages' sources, and all of printable ASCII: a few more than shown, never one missing.
let text = ''
for (let c = 0x20; c < 0x7f; c++) text += String.fromCharCode(c)
for (const file of new Glob('src/**/*.{astro,ts,tsx,css}').scanSync({ cwd: site })) text += await Bun.file(resolve(site, file)).text()
const chars = [...new Set(text)].join('')

const font = Buffer.from(await Bun.file(resolve(pub, 'fonts/fusion-pixel-12px-proportional-zh_hans.otf')).arrayBuffer())
const woff2 = await subsetFont(font, chars, { targetFormat: 'woff2' })
await Bun.write(resolve(out, 'pixel.woff2'), woff2)
// The font's licence (SIL OFL) goes wherever the font does.
await Bun.write(resolve(out, 'fusion-pixel-OFL.txt'), Bun.file(resolve(pub, 'fonts/fusion-pixel-OFL.txt')))

for (const size of [32, 64, 256]) await Bun.write(resolve(out, `icon-${size}.png`), Bun.file(resolve(pub, `icons/app-${size}.png`)))

// Base.astro points og:image at card-<lang>.jpg.
for (const copy of [zh, en]) await Bun.write(resolve(out, `card-${copy.lang}.jpg`), await drawCard(copy, font, resolve(pub, 'pixel/title-evening.jpg')))

console.log(`prepare: pixel.woff2 ${(woff2.length / 1024).toFixed(0)} KB for ${chars.length} characters, icons, share cards`)
