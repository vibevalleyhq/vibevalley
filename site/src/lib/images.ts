import type { ImageMetadata } from 'astro'
import { getImage } from 'astro:assets'
import { byName } from './files'
import { SCENES, SHOWN, type Scene, type SpriteName } from './scene'

// Only the pictures the pages show are imported: Astro drops an original once its copy is made, but keeps every imported picture it never copied.
const title = byName(
  import.meta.glob<{ default: ImageMetadata }>(
  '@game/title/{cloud-big-1,cloud-wisp-1,cloud-mid-2,puff-1,puff-2,wisp-1,wisp-2,fern,grass-tall,grass-daisy,grass-low,grass-yellow,grass-dandelion,dandelion-1,dandelion-2,dandelion-3,seed-1,seed-2,seed-3,seed-4,manager-morning,manager-day,manager-evening,manager-night,dog-sit,dog-tail,dog-look,dog-sleep}.png',
    { eager: true },
  ),
)
const backgrounds = byName(import.meta.glob<{ default: ImageMetadata }>('@game/pixel/title-{morning,day,evening,night}.jpg', { eager: true }))
const shots = byName(import.meta.glob<{ default: ImageMetadata }>('@shots/{farm.png,title.jpg,chat.png,phone-chat.png,phone-issues.png}', { eager: true }))

const of = (images: Record<string, { default: ImageMetadata }>, path: string) => {
  const image = images[path]?.default
  if (!image) throw new Error(`no picture ${path}`)
  return image
}

/** The title scene's sprites the pages show, by name. */
export async function titleArt(): Promise<Record<SpriteName, string>> {
  const pairs = await Promise.all(SHOWN.map(async (name) => [name, (await getImage({ src: of(title, `${name}.png`), format: 'webp', quality: 90 })).src] as const))
  return Object.fromEntries(pairs) as Record<SpriteName, string>
}

/** Each hour's picture of the farm. */
export async function backgroundsOf(): Promise<Record<Scene, string>> {
  const pairs = await Promise.all(SCENES.map(async (s) => [s, (await getImage({ src: of(backgrounds, `title-${s}.jpg`), format: 'webp', quality: 82 })).src] as const))
  return Object.fromEntries(pairs) as Record<Scene, string>
}

/** A screenshot from docs/images by its file's name, in a few widths (each its own copy, so the original is dropped). */
export async function screenshotOf(name: string) {
  const image = shots[`${name}.png`]?.default ?? of(shots, `${name}.jpg`)
  // Only reading its src counts as using the original (which then ships as well): its size is free to read.
  const { width, height } = image
  const widths = [480, 720, 1080, width].filter((w, i, all) => w <= width && all.indexOf(w) === i)
  const copies = await Promise.all(widths.map((w) => getImage({ src: image, format: 'webp', quality: 80, width: w })))
  return { src: copies.at(-1)!.src, srcset: copies.map((c, i) => `${c.src} ${widths[i]}w`).join(', '), width, height }
}
