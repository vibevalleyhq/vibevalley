// The title scene as the game draws it, over the page's first two screens. The scene holds on the screen through the
// first screen of scrolling while a whole day goes by, dawn to night (the pictures fade one over the other as the page
// goes, back as it comes back), a line of the verse for each hour (copy.hero.verses, rhyming), the camera pushing in a
// little, the nearer layers more, and the opening words fading; then the whole scene goes up off the screen, its
// layers parting, the farther the slower. The layers: the clouds; the farm's
// picture with its smoke, fireflies, the farmer and his dog; the plants along the bottom; and right in front of the
// camera, the plants that frame the village in the game. They also move against the pointer, on springs. The hours'
// buttons go to that point of the scroll. The scene's own motions are CSS (the theme's animate-*); following the
// scroll is Motion's scroll() (useScrollLinked: on the browser's own scroll timelines where it has them).
import { MotionConfig, motion, useMotionValue, useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from 'motion/react'
import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react'
import type { Copy } from '../i18n/zh'
import { CHIMNEY, CLOUDS, DOG, MANAGER, PET, PLANTS, PUFF_SECONDS, PUFFS, SCENES, SEEDS, firefliesOf, managerOf, pct, sprite, type Scene, type SpriteName } from '../lib/scene'
import { PixelLink, STILL, cx, useOffScreen, useScrollLinked, vars } from './ui'

/** A part that belongs to one hour shows at that hour (data-scene on <html>), fading in and out as the hour changes. */
const AT: Record<Scene, string> = { morning: 'morning:opacity-100', day: 'day:opacity-100', evening: 'evening:opacity-100', night: 'night:opacity-100' }
/** The hour's own button looks pressed while the farm is at that hour. */
const PRESSED: Record<Scene, string> = { morning: 'morning:bg-wheat', day: 'day:bg-wheat', evening: 'evening:bg-wheat', night: 'night:bg-wheat' }

/** The plants in front of the camera that frame the village in the game (app/lib/village/game.dart): at the hero's
 *  corners, mostly past its edges. Two art pixels a pixel, three on a wide screen. */
const FRAME = [
  { name: 'branchLeft', className: 'top-[-44px] left-[-60px] w-[206px] lg:top-[-66px] lg:left-[-90px] lg:w-[309px]' },
  { name: 'branchRight', className: 'top-[-48px] right-[-52px] w-[194px] lg:top-[-72px] lg:right-[-78px] lg:w-[291px]' },
  { name: 'bushLeft', className: 'bottom-[-72px] left-[-64px] w-[232px] lg:bottom-[-108px] lg:left-[-96px] lg:w-[348px]' },
  { name: 'bushRight', className: 'right-[-68px] bottom-[-64px] w-[236px] lg:right-[-102px] lg:bottom-[-96px] lg:w-[354px]' },
] as const

export type Frame = Record<(typeof FRAME)[number]['name'], string>

/** The first screen of scrolling, while the scene holds on the screen (the hero is two screens high). */
const HOLDING = ['start start', 'end end'] as ['start start', 'end end']
/** The second, while the scene goes up off the screen. */
const LEAVING = ['end end', 'end start'] as ['end end', 'end start']

/** How far through the holding screen each later hour has faded in: dawn's picture lies under the others, each later
 *  one comes in over the one before. The hours' lights and poses turn halfway through each fade. */
const COMES: Record<Exclude<Scene, 'morning'>, [number, number]> = { day: [0.14, 0.3], evening: [0.42, 0.58], night: [0.7, 0.86] }
const TURNS: [number, Scene][] = [
  [0, 'morning'],
  [0.22, 'day'],
  [0.5, 'evening'],
  [0.78, 'night'],
]
/** Each later hour's line of the verse, through the holding screen: coming in, in, going, gone (the night's stays).
 *  Dawn's line is with the opening words, which are gone by 0.22. */
const SAYS: Record<Exclude<Scene, 'morning'>, [number, number, number, number]> = {
  day: [0.24, 0.3, 0.44, 0.5],
  evening: [0.52, 0.58, 0.7, 0.76],
  night: [0.8, 0.86, 1, 1],
}
/** Where the hours' buttons take the page, as a share of the holding screen: each hour while its line is up. */
const POINTS: Record<Scene, number> = { morning: 0, day: 0.37, evening: 0.64, night: 1 }

const farmers = Object.fromEntries(SCENES.map((s) => [s, managerOf(s)])) as Record<Scene, ReturnType<typeof managerOf>>
const flies = { evening: firefliesOf('evening'), night: firefliesOf('night') }

/** The dog's round by day: sits, swishes its tail, looks back now and then. */
const ROUND = [
  ['sit', 1400],
  ['tail', 500],
  ['sit', 500],
  ['tail', 500],
  ['sit', 2600],
  ['look', 2200],
  ['sit', 1800],
  ['tail', 600],
] as const

/** The pictures of an hour still waiting for their src: its background and the farmer's pose. */
const picturesOf = (root: ParentNode, scene: Scene) => [...root.querySelectorAll<HTMLImageElement>(`[data-scene="${scene}"][data-src], [data-scene="${scene}"] [data-src]`)]

interface Props {
  copy: Copy['hero']
  /** The title scene's sprites, and each hour's picture (images.ts). */
  art: Record<SpriteName, string>
  backgrounds: Record<Scene, string>
  /** The arrow under "scroll down". */
  hint: string
  /** The frame's plants. */
  frame: Frame
  github: string
}

export default function Hero({ copy, art, backgrounds, hint: arrow, frame, github }: Props) {
  const root = useRef<HTMLElement>(null)
  const [scene, setScene] = useState<Scene>('morning')
  const wanted = useRef<Scene>('morning')
  // The pointer over the scene, -0.5 to 0.5 each way, followed on a spring; and how far the page has scrolled.
  const px = useSpring(useMotionValue(0), { stiffness: 50, damping: 18 })
  const py = useSpring(useMotionValue(0), { stiffness: 50, damping: 18 })
  const { scrollY } = useScroll()
  // While the scene holds: the opening words stay a little, then rise and are gone as day comes; the hint to scroll
  // goes at once.
  const words = useScrollLinked<HTMLDivElement>(root, HOLDING, () => [
    { keyframes: { transform: ['translateY(0px)', 'translateY(0px)', 'translateY(-60px)', 'translateY(-60px)'] }, times: [0, 0.12, 0.22, 1] },
    { keyframes: { opacity: [1, 1, 0, 0] }, times: [0, 0.12, 0.22, 1] },
  ])
  const hint = useScrollLinked<HTMLAnchorElement>(root, HOLDING, () => [{ keyframes: { opacity: [1, 0, 0] }, times: [0, 0.08, 1] }])
  const ahead = useRef(false)
  useOffScreen(root)

  /** How far through the holding screen the page is, 0 to 1. */
  const held = (y: number) => {
    const hero = root.current
    const span = hero ? hero.offsetHeight - innerHeight : innerHeight
    return Math.min(1, Math.max(0, y / Math.max(1, span)))
  }
  useMotionValueEvent(scrollY, 'change', (y) => {
    // The later hours' pictures load as soon as the page moves, so each is there when its turn comes.
    if (!ahead.current && y > 0 && root.current) {
      ahead.current = true
      for (const s of SCENES) for (const img of picturesOf(root.current, s)) if (!img.getAttribute('src')) img.src = img.dataset.src ?? ''
    }
    const q = held(y)
    const hour = TURNS.filter(([from]) => q >= from).at(-1)![1]
    if (hour !== wanted.current) relight(hour)
  })

  /** An hour's button: the page goes to where the farm is at that hour. */
  function go(s: Scene) {
    const hero = root.current
    if (!hero) return
    window.scrollTo({ top: POINTS[s] * (hero.offsetHeight - innerHeight), behavior: STILL ? 'auto' : 'smooth' })
  }

  /** The farm's lights and poses at another hour: the farmer's pose loads first, then the farm turns to that light. */
  async function relight(next: Scene) {
    wanted.current = next
    setScene(next)
    const pictures = root.current ? picturesOf(root.current, next) : []
    await Promise.all(
      pictures.map((img) => {
        if (!img.getAttribute('src')) img.src = img.dataset.src ?? ''
        return img.decode().catch(() => {})
      }),
    )
    if (wanted.current === next) document.documentElement.dataset.scene = next
  }

  function point(e: PointerEvent<HTMLElement>) {
    if (STILL || e.pointerType !== 'mouse') return
    const box = e.currentTarget.getBoundingClientRect()
    px.set((e.clientX - box.left) / box.width - 0.5)
    py.set((e.clientY - box.top) / box.height - 0.5)
  }
  function leave() {
    px.set(0)
    py.set(0)
  }

  const stagger = Math.min(70, 420 / [...copy.name].length)
  const after = [...copy.name].length * stagger + 260

  return (
    <MotionConfig reducedMotion="user">
      {/* Two screens high: the scene holds on the first screen of scrolling, and goes up off the screen on the second. */}
      <section ref={root} id="top" aria-label={copy.name} className="relative h-[200svh] min-h-[1120px]">
        <div onPointerMove={point} onPointerLeave={leave} className="sticky top-0 isolate h-svh min-h-[560px] overflow-hidden bg-dusk [container-type:size]">
          {/* The scene keeps its 3:2 and covers the hero, a little bigger, so the layers have room to part. */}
          <div aria-hidden="true" className="absolute top-1/2 left-1/2 aspect-3/2 w-[max(108cqw,calc(108cqh*1.5))] -translate-1/2 [container-type:size]">
            {/* The farm: its picture, the smoke and the fireflies over it, the farmer and the dog on the hill. */}
            <Layer lag={0.5} zoom={1.06} origin="62% 60%" point={16} hero={root} px={px} py={py}>
              <div className="absolute inset-0 origin-[60%_55%] animate-pan">
                {/* The hours' pictures: the day's at the bottom, each later one fading in over it as the page goes. */}
                <img data-scene="morning" data-src={backgrounds.morning} alt="" draggable={false} className="absolute inset-0 size-full max-w-none select-none pixelated" />
                <Comes hour="day" src={backgrounds.day} hero={root} />
                <Comes hour="evening" src={backgrounds.evening} hero={root} />
                <Comes hour="night" src={backgrounds.night} hero={root} />
                <noscript>
                  <img src={backgrounds.morning} alt="" className="absolute inset-0 size-full max-w-none pixelated" />
                </noscript>
                {PUFFS.map((p, i) => {
                  const s = sprite(p.sprite, p.scale)
                  return (
                    <img
                      key={i}
                      src={art[s.name]}
                      alt=""
                      draggable={false}
                      fetchPriority="low"
                      className="absolute top-(--y0) left-(--x0) max-w-none origin-bottom -translate-x-1/2 -translate-y-full animate-puff opacity-0 select-none lit-smoke pixelated"
                      style={{
                        ...vars({ '--x0': pct(CHIMNEY.x), '--y0': pct(CHIMNEY.y) }),
                        width: pct(s.w),
                        animationDuration: `${PUFF_SECONDS}s`,
                        animationDelay: `${-(i * PUFF_SECONDS) / PUFFS.length}s`,
                      }}
                    />
                  )
                })}
                {(['evening', 'night'] as const).map((at) => (
                  <div key={at} className={cx('absolute inset-0 opacity-0 transition-opacity duration-900', AT[at])}>
                    {flies[at].map((f, i) => (
                      <span
                        key={i}
                        className="absolute animate-firefly bg-firefly shadow-[0_0_6px_2px_rgb(255_214_90/0.75)]"
                        style={{
                          left: `${f.x}%`,
                          top: `${f.y}%`,
                          width: f.size,
                          height: f.size,
                          animationDuration: `${f.duration}s,${1.6 + (i % 5) * 0.4}s`,
                          animationDelay: `${f.delay}s`,
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {SCENES.map((s) => (
                <div
                  key={s}
                  data-scene={s}
                  className={cx('absolute origin-bottom animate-breathe opacity-0 transition-opacity duration-900', AT[s])}
                  style={{
                    left: pct(MANAGER.x - farmers[s].w / 2),
                    top: pct(MANAGER.bottom - farmers[s].h),
                    width: pct(farmers[s].w),
                    height: pct(farmers[s].h),
                  }}
                >
                  <img data-src={art[farmers[s].name]} alt="" draggable={false} className="block size-full max-w-none select-none lit-farmer pixelated" />
                  {s === 'night' && (
                    <span className="absolute top-[70%] left-[4%] aspect-square w-[34%] -translate-1/2 animate-lantern rounded-full bg-[radial-gradient(circle,rgb(255_210_110/0.55),rgb(255_170_60/0.2)_45%,transparent_70%)] mix-blend-screen" />
                  )}
                </div>
              ))}
              <Dog scene={scene} art={art} />
            </Layer>
            {/* The clouds, the farthest. */}
            <Layer lag={0.62} zoom={1.03} origin="50% 30%" point={8} hero={root} px={px} py={py}>
              {CLOUDS.map((c, i) => {
                const s = sprite(c.sprite, c.scale)
                return (
                  <img
                    key={i}
                    src={art[s.name]}
                    alt=""
                    draggable={false}
                    fetchPriority="low"
                    className="absolute left-0 max-w-none animate-cloud select-none lit-sky pixelated"
                    style={{ top: pct(c.y), width: pct(s.w), animationDuration: `${c.duration}s`, animationDelay: `${c.delay}s` }}
                  />
                )
              })}
            </Layer>
            {/* The plants along the bottom, nearer. */}
            <Layer lag={0.28} zoom={1.12} origin="50% 100%" point={36} hero={root} px={px} py={py}>
              {/* Seeds blow off the dandelions by day; at night they rest. */}
              <div className="absolute inset-0 transition-opacity duration-900 night:opacity-0">
                {SEEDS.map((seed, i) => {
                  const s = sprite(seed.sprite, 0.22)
                  return (
                    <span
                      key={i}
                      className="absolute top-[86%] left-(--x0) animate-seed opacity-0"
                      style={{ ...vars({ '--x0': pct(seed.from) }), width: pct(s.w), animationDuration: `${seed.duration}s`, animationDelay: `${seed.delay}s` }}
                    >
                      <img
                        src={art[s.name]}
                        alt=""
                        draggable={false}
                        fetchPriority="low"
                        className="block w-full max-w-none animate-seed-spin lit-ground pixelated"
                        style={{ animationDelay: `${seed.delay}s` }}
                      />
                    </span>
                  )
                })}
              </div>
              {PLANTS.map((p, i) => {
                const s = sprite(p.sprite, p.scale)
                return (
                  <img
                    key={i}
                    src={art[s.name]}
                    alt=""
                    draggable={false}
                    fetchPriority="low"
                    className="absolute bottom-0 max-w-none origin-bottom animate-sway select-none lit-ground pixelated"
                    style={{ ...vars({ '--lean': `${p.lean}deg` }), left: pct(p.x - s.w / 2), width: pct(s.w), animationDuration: `${p.sway}s`, animationDelay: `${-i * 0.7}s` }}
                  />
                )
              })}
            </Layer>
          </div>
          {/* In front of the camera, ahead of the page: the frame's plants, pushed out past the corners as the camera goes in. */}
          <Layer lag={-0.08} zoom={1.3} origin="50% 50%" point={64} hero={root} px={px} py={py} className="pointer-events-none">
            {FRAME.map((f) => (
              <img key={f.name} src={frame[f.name]} alt="" aria-hidden="true" draggable={false} className={cx('absolute max-w-none select-none lit-ground pixelated', f.className)} />
            ))}
          </Layer>

          {/* The words over the scene: at the left as on the game's title screen, at the bottom on a narrow screen, on a
              shade that stays while they change. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-2 bg-linear-0 from-shade/75 via-shade/35 via-55% to-transparent to-80% md:bg-linear-90 md:from-shade/55 md:via-shade/25 md:via-45% md:to-70%"
          />
          <div
            ref={words}
            className="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end gap-[18px] px-[clamp(16px,6vw,96px)] pt-24 pb-24 text-cream-50 *:pointer-events-auto md:justify-center md:pb-[120px]"
          >
            <div className="motion-safe:animate-float">
              <h1 className="text-[clamp(48px,7vw,96px)] text-shadow-title">
                <span className="sr-only">{copy.name}</span>
                <span aria-hidden="true">
                  {[...copy.name].map((ch, i) => (
                    <span key={i} className="inline-block motion-safe:animate-pop" style={{ animationDelay: `${i * stagger}ms` }}>
                      {ch}
                    </span>
                  ))}
                </span>
                <span className="mt-2.5 block text-2xl/none text-wheat text-shadow-ink">{copy.aka}</span>
              </h1>
            </div>
            <p className="font-pixel text-[clamp(30px,4.2vw,54px)]/[1.15] text-wheat text-shadow-ink motion-safe:animate-in" style={{ animationDelay: `${after}ms` }}>
              {copy.tagline}
            </p>
            <p className="font-pixel text-[clamp(20px,2.4vw,30px)]/[1.3] text-shadow-ink motion-safe:animate-in" style={{ animationDelay: `${after + 90}ms` }}>
              {copy.verses.morning.join('')}
            </p>
            <p className="max-w-[34em] text-base text-shadow-thin motion-safe:animate-in sm:text-lg" style={{ animationDelay: `${after + 180}ms` }}>
              {copy.lead}
            </p>
            <div className="mt-2 flex flex-wrap gap-3.5 motion-safe:animate-in" style={{ animationDelay: `${after + 270}ms` }}>
              <PixelLink primary href={github}>
                {copy.primary}
              </PixelLink>
              <PixelLink href="#how">{copy.secondary}</PixelLink>
            </div>
          </div>

          {(['day', 'evening', 'night'] as const).map((h) => (
            <Line key={h} verse={copy.verses[h]} at={SAYS[h]} stays={h === 'night'} hero={root} />
          ))}

          <div
            role="group"
            aria-label={copy.hours}
            className="absolute bottom-5 left-4 z-3 flex items-center gap-1.5 font-pixel text-lg/none text-cream-50 text-shadow-ink md:right-[clamp(16px,4vw,40px)] md:bottom-7 md:left-auto"
          >
            <span className="hidden md:inline">{copy.hours}</span>
            {SCENES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={s === scene}
                onClick={() => go(s)}
                className={cx('cursor-pointer border-2 border-bark-900 bg-cream-50 px-2.5 py-1.5 text-bark-900 shadow-hard-sm hover:bg-cream-hover', PRESSED[s])}
              >
                {copy.hour[s]}
              </button>
            ))}
          </div>
          <a
            ref={hint}
            href="#parade"
            className="absolute bottom-[22px] left-1/2 z-3 hidden -translate-x-1/2 justify-items-center gap-1 font-pixel text-lg/none text-cream-50 text-shadow-ink md:grid"
          >
            {copy.scroll}
            <img src={arrow} alt="" className="w-5 rotate-90 pixelated motion-safe:animate-hint" />
          </a>
        </div>
      </section>
    </MotionConfig>
  )
}

/** A later hour's picture, fading in over the earlier ones as the page goes through the holding screen (and out as it
 *  comes back). A fade, not a motion, so it follows the scroll for everyone. */
function Comes({ hour, src, hero }: { hour: Exclude<Scene, 'morning'>; src: string; hero: RefObject<HTMLElement | null> }) {
  const [from, to] = COMES[hour]
  const ref = useScrollLinked<HTMLImageElement>(hero, HOLDING, () => [{ keyframes: { opacity: [0, 0, 1, 1] }, times: [0, from, to, 1] }], { still: true })
  return <img ref={ref} data-scene={hour} data-src={src} alt="" draggable={false} className="absolute inset-0 size-full max-w-none opacity-0 select-none pixelated" />
}

/** An hour's line of the verse, big where the opening words were: in, held and out as the page goes through the holding
 *  screen (the night's stays until the scene leaves). It shows and hides for everyone; only those who allow motion see
 *  it rise as well. */
function Line({ verse, at, stays, hero }: { verse: string[]; at: [number, number, number, number]; stays: boolean; hero: RefObject<HTMLElement | null> }) {
  const [a, b, c, d] = at
  const seen = useScrollLinked<HTMLDivElement>(
    hero,
    HOLDING,
    () => [stays ? { keyframes: { opacity: [0, 0, 1, 1] }, times: [0, a, b, 1] } : { keyframes: { opacity: [0, 0, 1, 1, 0, 0] }, times: [0, a, b, c, d, 1] }],
    { still: true },
  )
  const rise = useScrollLinked<HTMLParagraphElement>(hero, HOLDING, () => [
    stays
      ? { keyframes: { transform: ['translateY(28px)', 'translateY(28px)', 'translateY(0px)', 'translateY(0px)'] }, times: [0, a, b, 1] }
      : {
          keyframes: { transform: ['translateY(28px)', 'translateY(28px)', 'translateY(0px)', 'translateY(0px)', 'translateY(-28px)', 'translateY(-28px)'] },
          times: [0, a, b, c, d, 1],
        },
  ])
  return (
    <div ref={seen} className="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end px-[clamp(16px,6vw,96px)] pt-24 pb-28 text-cream-50 opacity-0 md:justify-center md:pb-[120px]">
      <p ref={rise} className="font-pixel text-[clamp(34px,5.2vw,72px)]/[1.25] text-shadow-title">
        {verse.map((half, i) => (
          <span key={i} className="block">
            {half}
          </span>
        ))}
      </p>
    </div>
  )
}

/**
 * One layer of the scene. While the scene holds, it pushes in toward its origin by its zoom (the nearer, the more);
 * while the scene goes up off the screen, it lags behind the page by its share of the scroll (the farther, the more:
 * at half, it goes up at half the page's pace; below zero, ahead of it); and it moves against the pointer by up to its
 * pixels (the nearer, the more). Nearer layers only ever go up past the farther ones, so a layer never shows what is
 * behind its edge.
 */
function Layer({
  lag,
  zoom,
  origin,
  point,
  hero,
  px,
  py,
  className,
  children,
}: {
  lag: number
  zoom: number
  origin: string
  point: number
  hero: RefObject<HTMLElement | null>
  px: MotionValue<number>
  py: MotionValue<number>
  className?: string
  children: ReactNode
}) {
  const away = useScrollLinked<HTMLDivElement>(hero, LEAVING, () => [{ keyframes: { transform: ['translateY(0px)', `translateY(${lag * innerHeight}px)`] } }])
  const closer = useScrollLinked<HTMLDivElement>(hero, HOLDING, () => [{ keyframes: { transform: ['scale(1)', `scale(${zoom})`] } }])
  const x = useTransform(() => (STILL ? 0 : -px.get() * point))
  const y = useTransform(() => (STILL ? 0 : -py.get() * point * 0.6))
  return (
    <div ref={away} className={cx('absolute inset-0', className)}>
      <div ref={closer} className="absolute inset-0" style={{ transformOrigin: origin }}>
        <motion.div className="absolute inset-0 will-change-transform" style={{ x, y }}>
          {children}
        </motion.div>
      </div>
    </div>
  )
}

/** The dog by the farmer: its round by day, asleep at night; it looks up and hops when the pointer comes by. */
function Dog({ scene, art }: { scene: Scene; art: Record<SpriteName, string> }) {
  const [frame, setFrame] = useState<keyof typeof DOG>('sit')
  const [noticed, setNoticed] = useState(false)
  useEffect(() => {
    if (noticed) return setFrame('look')
    if (scene === 'night') return setFrame('sleep')
    if (STILL) return setFrame('sit')
    let at = 0
    let timer = 0
    const step = () => {
      const [name, ms] = ROUND[at++ % ROUND.length]!
      setFrame(name)
      timer = window.setTimeout(step, ms)
    }
    step()
    return () => window.clearTimeout(timer)
  }, [scene, noticed])
  const f = DOG[frame]
  return (
    <motion.img
      src={art[f.name]}
      alt=""
      draggable={false}
      onPointerEnter={() => setNoticed(true)}
      onPointerLeave={() => setNoticed(false)}
      animate={noticed ? { y: [0, -14, 0, -7, 0] } : { y: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
      className="absolute max-w-none -translate-x-1/2 select-none lit-ground pixelated"
      style={{ left: pct(PET.x), bottom: pct(1 - PET.bottom), width: pct(f.w) }}
    />
  )
}
