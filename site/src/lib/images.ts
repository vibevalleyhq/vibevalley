// The game's pictures as the site sends them: compressed copies made at build time (Astro's image service, sharp) from
// the originals in app/assets and docs/images, which stay as they are: the game ships the originals. Only the pages
// call these; the islands get the copies' addresses.
//   - The title scene's pictures and sprites: WebP at their own size (lossy, at a quality where a zoomed crop shows no
//     difference), a fifth to a half of the originals.
//   - Screenshots: WebP in a few widths, for the browser to pick by the screen.
//   - The share card stays the original JPEG, which every site that shows cards can read.
import type { ImageMetadata } from 'astro'
import { getImage } from 'astro:assets'
import { SCENES, SHOWN, type Scene, type SpriteName } from './scene'

// Only the pictures the pages show are imported: Astro drops an original once its copy is made, but keeps every
// imported picture it never copied. SHOWN (scene.ts) must be in this list; titleArt says so if one is not.
const title = import.meta.glob<{ default: ImageMetadata }>(
  '../../../app/assets/title/{cloud-big-1,cloud-wisp-1,cloud-mid-2,puff-1,puff-2,wisp-1,wisp-2,fern,grass-tall,grass-daisy,grass-low,grass-yellow,grass-dandelion,dandelion-1,dandelion-2,dandelion-3,seed-1,seed-2,seed-3,seed-4,manager-morning,manager-day,manager-evening,manager-night,dog-sit,dog-tail,dog-look,dog-sleep}.png',
  { eager: true },
)
const backgrounds = import.meta.glob<{ default: ImageMetadata }>('../../../app/assets/pixel/title-{morning,day,evening,night}.jpg', { eager: true })
const shots = import.meta.glob<{ default: ImageMetadata }>('../../../docs/images/{farm.png,title.jpg,chat.png,phone-chat.png,phone-tickets.png}', { eager: true })

const of = (images: Record<string, { default: ImageMetadata }>, path: string) => {
  const image = images[path]?.default
  if (!image) throw new Error(`no picture ${path}`)
  return image
}

/** The title scene's sprites the pages show, by name. */
export async function titleArt(): Promise<Record<SpriteName, string>> {
  const pairs = await Promise.all(SHOWN.map(async (name) => [name, (await getImage({ src: of(title, `../../../app/assets/title/${name}.png`), format: 'webp', quality: 90 })).src] as const))
  return Object.fromEntries(pairs) as Record<SpriteName, string>
}

/** Each hour's picture of the farm. */
export async function backgroundsOf(): Promise<Record<Scene, string>> {
  const pairs = await Promise.all(SCENES.map(async (s) => [s, (await getImage({ src: of(backgrounds, `../../../app/assets/pixel/title-${s}.jpg`), format: 'webp', quality: 82 })).src] as const))
  return Object.fromEntries(pairs) as Record<Scene, string>
}

/** The share card: the farm at dusk, the original JPEG. */
export const cardOf = () => of(backgrounds, '../../../app/assets/pixel/title-evening.jpg').src

/** A screenshot from docs/images by its file's name, in a few widths (each its own copy, so the original is dropped). */
export async function screenshotOf(name: string) {
  const image = shots[`../../../docs/images/${name}.png`]?.default ?? of(shots, `../../../docs/images/${name}.jpg`)
  // Its size from Astro's copy of the metadata: reading the picture itself counts as using the original, which then
  // ships as well.
  const { width, height } = (image as ImageMetadata & { clone: ImageMetadata }).clone
  const widths = [480, 720, 1080, width].filter((w, i, all) => w <= width && all.indexOf(w) === i)
  const copies = await Promise.all(widths.map((w) => getImage({ src: image, format: 'webp', quality: 80, width: w })))
  return { src: copies.at(-1)!.src, srcset: copies.map((c, i) => `${c.src} ${widths[i]}w`).join(', '), width, height }
}
