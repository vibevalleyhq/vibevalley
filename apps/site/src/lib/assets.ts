import sizes from "@game/pixel/sprites.json";

import { byName } from "./files";
import type { Art, StoryArt } from "./story";

const spriteSizes: Readonly<Record<string, { w: number; h: number; ax?: number; ay?: number } | undefined>> = sizes;

const pixel = byName(
  import.meta.glob<string>(
    [
      "@game/pixel/{icon,act,button,mark,logo,app,plot,fg}-*.png",
      "@game/pixel/{coins-stack,stamp-done,dog-scratch,plot-dry}.png",
      "@game/pixel/{prop-board,prop-table,prop-crates,machine-seeder,machine-windmill,machine-beehive,machine-tractor}.png",
      "@game/pixel/bear-farmer-{side,side-1,side-2,cheer,up,read,work,tinker-1,tinker-2,hammer-1,hammer-2}.png",
    ],
    { eager: true, query: "?url", import: "default" },
  ),
);
const walkers = byName(
  import.meta.glob<string>("@game/pixel/{bear-farmer,rabbit-gardener,fox-rain,cat-winter,owl-farmer,hedgehog-gardener,raccoon-rain}-side*.png", {
    eager: true,
    query: "?url",
    import: "default",
  }),
);

/** A pixel sprite by its name in apps/web/public/pixel (icon-seeds, act-run_command, logo-claude, plot-wheat…). */
export function pixelArt(name: string): string {
  const url = pixel[`${name}.png`];
  if (!url) throw new Error(`no sprite ${name}`);
  return url;
}

/** Frames in a step cycle: step, stand, step, stand. */
export const WALKERS = ["bear-farmer", "rabbit-gardener", "fox-rain", "cat-winter", "owl-farmer", "hedgehog-gardener", "raccoon-rain"].map((look) => ({
  look,
  frames: ["side-1", "side", "side-2", "side"].map((f) => walkers[`${look}-${f}.png`] ?? ""),
}));

export const RUNTIMES = [
  { name: "pi", logo: "logo-pi" },
  { name: "Claude Code", logo: "logo-claude" },
  { name: "Codex", logo: "logo-codex" },
] as const;

/** ax/ay locate the sprite's feet in sprites.json coordinates. */
function pixelSprite(name: string): Art {
  const size = spriteSizes[name];
  if (!size) throw new Error(`no sprite size ${name}`);
  return { src: pixelArt(name), w: size.w, h: size.h, ax: size.ax ?? Math.round(size.w / 2), ay: size.ay ?? size.h - 1 };
}

export function storyArt(): StoryArt {
  return {
    side: pixelSprite("bear-farmer-side"),
    "side-1": pixelSprite("bear-farmer-side-1"),
    "side-2": pixelSprite("bear-farmer-side-2"),
    up: pixelSprite("bear-farmer-up"),
    read: pixelSprite("bear-farmer-read"),
    work: pixelSprite("bear-farmer-work"),
    "tinker-1": pixelSprite("bear-farmer-tinker-1"),
    "tinker-2": pixelSprite("bear-farmer-tinker-2"),
    "hammer-1": pixelSprite("bear-farmer-hammer-1"),
    "hammer-2": pixelSprite("bear-farmer-hammer-2"),
    cheer: pixelSprite("bear-farmer-cheer"),
    "prop-board": pixelSprite("prop-board"),
    "machine-seeder": pixelSprite("machine-seeder"),
    "prop-table": pixelSprite("prop-table"),
    "prop-crates": pixelSprite("prop-crates"),
    "machine-windmill": pixelSprite("machine-windmill"),
    "machine-beehive": pixelSprite("machine-beehive"),
    "machine-tractor": pixelSprite("machine-tractor"),
    "plot-empty": pixelSprite("plot-empty"),
    "plot-seeded": pixelSprite("plot-seeded"),
    "plot-sprout": pixelSprite("plot-sprout"),
    "plot-leafy": pixelSprite("plot-leafy"),
    "plot-flowering": pixelSprite("plot-flowering"),
    "plot-wheat": pixelSprite("plot-wheat"),
    "act-speaking_text": pixelSprite("act-speaking_text"),
    "act-thinking": pixelSprite("act-thinking"),
    "icon-seeds": pixelSprite("icon-seeds"),
    "act-read_file": pixelSprite("act-read_file"),
    "act-search": pixelSprite("act-search"),
    "act-edit_file": pixelSprite("act-edit_file"),
    "act-run_command": pixelSprite("act-run_command"),
    "mark-check": pixelSprite("mark-check"),
    "coins-stack": pixelSprite("coins-stack"),
    "stamp-done": pixelSprite("stamp-done"),
    "fg-grass": pixelSprite("fg-grass"),
    "fg-fern": pixelSprite("fg-fern"),
  };
}
