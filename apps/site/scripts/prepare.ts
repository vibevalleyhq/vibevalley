import { copyFileSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import subsetFont from "subset-font";

import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";
import { drawCard } from "./card";
import { prepareImages } from "./images";

await prepareImages();

const site = resolve(import.meta.dirname, "..");
const pub = resolve(site, "../web/public");
const out = resolve(site, "public/gen");
mkdirSync(out, { recursive: true });

// Every character in the pages' sources, and all of printable ASCII: a few more than shown, never one missing.
let text = "";
for (let c = 0x20; c < 0x7f; c++) text += String.fromCharCode(c);
for (const file of globSync(
  ["ts", "tsx", "css"].map((ext) => `src/**/*.${ext}`),
  { cwd: site },
))
  text += readFileSync(resolve(site, file), "utf8");
const chars = [...new Set(text)].join("");

const font = readFileSync(resolve(pub, "fonts/fusion-pixel-12px-proportional-zh_hans.otf"));
const woff2 = await subsetFont(font, chars, { targetFormat: "woff2" });
writeFileSync(resolve(out, "pixel.woff2"), woff2);
// The font's licence (SIL OFL) goes wherever the font does.
copyFileSync(resolve(pub, "fonts/fusion-pixel-OFL.txt"), resolve(out, "fusion-pixel-OFL.txt"));

for (const size of [32, 64, 256]) copyFileSync(resolve(pub, `icons/app-${size}.png`), resolve(out, `icon-${size}.png`));

// Document.tsx points og:image at card-<lang>.jpg.
await Promise.all(
  [zh, en].map(async (copy) => writeFileSync(resolve(out, `card-${copy.lang}.jpg`), await drawCard(copy, font, resolve(pub, "pixel/title-evening.jpg")))),
);

console.log(`prepare: pixel.woff2 ${(woff2.length / 1024).toFixed(0)} KB for ${chars.length} characters, icons, share cards`);
