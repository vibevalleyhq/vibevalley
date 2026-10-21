// The game's small pixel pictures the page shows (apps/web/public/pixel: icons, plots, the helpers' frames…), as they are:
// a few KB each, and PNG keeps their pixels exact. Only the pages read these; the islands get the pictures' addresses.
// The big pictures (the title scene, the screenshots) go through images.ts, which compresses them.

import sizes from '../../../apps/web/public/pixel/sprites.json'
import { BUBBLES, FRONT, MARKS, PLOTS, POSES, THINGS, type Art, type StoryArt } from './story'

const pixel = import.meta.glob<string>(
  [
    '../../../apps/web/public/pixel/{icon,act,button,mark,logo,app,plot,fg}-*.png',
    '../../../apps/web/public/pixel/{coins-stack,stamp-done,dog-scratch,plot-dry}.png',
    '../../../apps/web/public/pixel/{prop-board,prop-table,prop-crates,machine-seeder,machine-windmill,machine-beehive,machine-tractor}.png',
    '../../../apps/web/public/pixel/bear-farmer-{side,side-1,side-2,cheer,up,read,work,tinker-1,tinker-2,hammer-1,hammer-2}.png',
  ],
  { eager: true, query: '?url', import: 'default' },
)
const walkers = import.meta.glob<string>(
  '../../../apps/web/public/pixel/{bear-farmer,rabbit-gardener,fox-rain,cat-winter,owl-farmer,hedgehog-gardener,raccoon-rain}-side*.png',
  { eager: true, query: '?url', import: 'default' },
)

/** A pixel sprite by its name in apps/web/public/pixel (icon-seeds, act-run_command, logo-claude, plot-wheat…). */
export function pixelArt(name: string): string {
  const url = pixel[`../../../apps/web/public/pixel/${name}.png`]
  if (!url) throw new Error(`no sprite ${name}`)
  return url
}

/** The helpers walking across the page: each its species and outfit, and its side frames in a step (step, stand, step, stand). */
export const WALKERS = ['bear-farmer', 'rabbit-gardener', 'fox-rain', 'cat-winter', 'owl-farmer', 'hedgehog-gardener', 'raccoon-rain'].map((look) => ({
  look,
  frames: ['side-1', 'side', 'side-2', 'side'].map((f) => walkers[`../../../apps/web/public/pixel/${look}-${f}.png`] ?? ''),
}))

/** The machines a helper can drive, by their pixel logos. */
export const RUNTIMES = [
  { name: 'pi', logo: 'logo-pi' },
  { name: 'Claude Code', logo: 'logo-claude' },
  { name: 'Codex', logo: 'logo-codex' },
] as const

/** A pixel sprite with its size and the point it stands on (sprites.json), for the field in How.tsx. */
function pixelSprite(name: string): Art {
  const size = sizes[name as keyof typeof sizes] as { w: number; h: number; ax?: number; ay?: number } | undefined
  if (!size) throw new Error(`no sprite size ${name}`)
  return { src: pixelArt(name), w: size.w, h: size.h, ax: size.ax ?? Math.round(size.w / 2), ay: size.ay ?? size.h - 1 }
}

/** Every picture the field in How.tsx draws: the helper's poses (the bear in its farmer's clothes), the things, the
 *  plots, the bubbles, the coins and the stamp, the grass in front. */
export function storyArt(): StoryArt {
  const art: Partial<StoryArt> = {}
  for (const pose of POSES) art[pose] = pixelSprite(`bear-farmer-${pose}`)
  for (const name of [...THINGS, ...PLOTS, ...BUBBLES, ...MARKS, ...FRONT]) art[name] = pixelSprite(name)
  return art as StoryArt
}
