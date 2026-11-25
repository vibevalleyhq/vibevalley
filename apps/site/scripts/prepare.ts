import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";
import { drawCard } from "./card";
import { prepareImages } from "./images";

await prepareImages();

const site = resolve(import.meta.dirname, "..");
const assets = resolve(site, "../../assets");
const out = resolve(site, "public/gen");
mkdirSync(out, { recursive: true });

// Remove stale font or license artifacts if present from earlier builds.
for (const entry of readdirSync(out)) {
  if (/\.(?:woff2|txt)$/u.test(entry)) rmSync(resolve(out, entry), { force: true });
}

for (const size of [32, 64, 256]) copyFileSync(resolve(assets, `icons/app-${size}.png`), resolve(out, `icon-${size}.png`));

const postcard = resolve(assets, "site/postcard.png");
const appIcon = resolve(assets, "icons/app-256.png");

// Document.tsx points og:image at card-<lang>.jpg.
await Promise.all([zh, en].map(async (copy) => writeFileSync(resolve(out, `card-${copy.lang}.jpg`), await drawCard(copy, postcard, appIcon))));

console.log("prepare: Papertrails hero scenes, screenshots, icons, share cards");
