// How a job grows. With the page's script, a story told as the page scrolls: the section holds still on the screen
// while the camera goes along a strip of field, the sky and hills slower and the grass in front faster, and the helper
// walks from place to place and does the work of each step there (lib/story.ts): reads the ticket at the board, sows,
// hammers at the workbench while its tools pop up and the crop comes up, and cheers over the harvest; under the field,
// the job's git branch grows with it (forked, committed, merged) and its counters go up. Scrolling back runs it back.
// The page is built with the story itself, at its first step, so waking it changes nothing on the page (a link to a
// section below lands where it should). For those who ask for less motion it steps from place to place without
// walking; without the script, the same four steps as a finished field, the merged branch and four cards (noscript).
import { AnimatePresence, MotionConfig, motion, steps, useMotionValue, useMotionValueEvent, useScroll, useTransform, type MotionValue } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Copy } from '../i18n/zh'
import { BACK, FIELD, JOB, NEAR, PACE, PLACES, START, branchAt, momentAt, stageOf, workAt, type Art, type Moment, type Pose, type StoryArt } from '../lib/story'
import { STILL, Section, cx, useReveal } from './ui'

interface Props {
  copy: Copy['how']
  /** Each step's icon. */
  icons: string[]
  /** The field's pictures (Home.astro, from lib/story.ts's lists). */
  art: StoryArt
}

export default function How({ copy, icons, art }: Props) {
  const root = useReveal<HTMLElement>()
  return (
    <MotionConfig reducedMotion="user">
      <Section ref={root} id="how" title={copy.title}>
        <Story copy={copy} icons={icons} art={art} />
        <noscript>
          <Finished copy={copy} icons={icons} art={art} />
        </noscript>
      </Section>
    </MotionConfig>
  )
}

// ── The finished field and the four cards ─────────────────────────────────────

function Finished({ copy, icons, art }: Props) {
  const grown = PLACES.map((_, i) => stageOf(i, { place: PLACES.length - 1, working: true, work: 1, x: 0 }))
  return (
    <div>
      <div aria-hidden="true" className="relative mb-12 overflow-hidden border-2 border-bark-900 bg-[linear-gradient(180deg,#8fbf5a,#76a046)] shadow-hard-lg">
        <div className="grid grid-cols-4 items-end gap-[22px] px-3 pt-6 sm:px-6 sm:pt-8 lg:px-0">
          {grown.map((stage, i) => (
            <div key={i} className="flex justify-center">
              <img loading="lazy" src={art[stage].src} alt="" className="w-[68px] max-w-none pixelated sm:w-[102px] lg:w-[136px]" />
            </div>
          ))}
        </div>
        <div className="relative mt-2 mb-3 h-10 border-y-2 border-path-edge bg-[repeating-linear-gradient(90deg,var(--color-path)_0_22px,var(--color-path-groove)_22px_26px)] sm:mb-4 sm:h-12">
          <img loading="lazy" src={art.cheer.src} alt="" className="absolute right-[4%] bottom-1.5 h-14 w-auto max-w-none pixelated sm:h-[84px] lg:h-28" />
        </div>
      </div>
      <div className="mb-12">
        <Branch copy={copy.git} now={{ place: PLACES.length - 1, working: true, work: 1, x: 0 }} check={art['mark-check'].src} />
      </div>
      <ol role="list" className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-4">
        {copy.steps.map((s, i) => (
          <li key={i} data-reveal={i * 80} className="relative mt-2.5 panel px-[22px] pt-[26px] pb-[22px] sm:mt-0">
            <span className="absolute -top-4 left-[18px] border-2 border-bark-900 bg-leaf-500 px-2.5 py-1.5 font-pixel text-lg/none text-cream-50">{i + 1}</span>
            <img loading="lazy" src={icons[i]} alt="" className="mb-3 size-14 object-contain pixelated" />
            <h3 className="mb-1.5 text-2xl">{s.title}</h3>
            <p className="text-base text-bark-800">{s.text}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ── The story ─────────────────────────────────────────────────────────────────

/** Two moments draw the same: the same step, the same pose and bubble, the same stages (the helper's place is not drawn by React). */
const sameDrawing = (a: Moment, b: Moment) => a.place === b.place && a.working === b.working && Math.floor(a.work * 40) === Math.floor(b.work * 40)

function Story({ copy, icons, art }: Props) {
  const track = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const helper = useRef<HTMLImageElement>(null)
  // The field's size on the screen: k screen pixels to an art pixel, and how much of the field shows across.
  const [k, setK] = useState(3)
  const shows = useRef(373)
  const [now, setNow] = useState<Moment>(() => momentAt(0))
  const camera = useMotionValue(0)
  const at = useMotionValue(START)
  const { scrollYProgress } = useScroll({ target: track, offset: ['start start', 'end end'] })

  const cameraFor = (x: number) => Math.min(Math.max(0, x - shows.current / 2), Math.max(0, FIELD.w - shows.current))

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = () => {
      const scale = Math.max(1, Math.round(el.clientHeight / FIELD.h))
      setK(scale)
      shows.current = el.clientWidth / scale
      camera.set(cameraFor(at.get()))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  // The helper's pose, drawn by hand (not by React), so it can change with every step it takes.
  const pose = useRef<{ name: Pose; facing: 1 | -1 }>({ name: 'side', facing: 1 })
  function show(name: Pose, facing: 1 | -1 = pose.current.facing) {
    const img = helper.current
    const a = art[name]
    if (!img) return
    pose.current = { name, facing }
    img.src = a.src
    img.style.left = `${-a.ax}px`
    img.style.top = `${-a.ay}px`
    img.style.transformOrigin = `${a.ax}px ${a.ay}px`
    img.style.scale = facing < 0 ? '-1 1' : '1 1'
  }

  // Walking: a step every 6 art pixels (step, stand, step, stand), facing the way it goes, standing once the page rests.
  const walked = useRef(0)
  const rest = useRef(0)
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const m = momentAt(p)
    // For those who ask for less motion, the helper is where the step is done, without the walk there.
    const x = STILL ? PLACES[m.place]!.at : m.x
    const dx = x - at.get()
    at.set(x)
    camera.set(cameraFor(x))
    if (!STILL && !m.working && Math.abs(dx) > 0.01) {
      walked.current += Math.abs(dx)
      show((['side-1', 'side', 'side-2', 'side'] as const)[Math.floor(walked.current / 6) % 4]!, dx < 0 ? -1 : 1)
      window.clearTimeout(rest.current)
      rest.current = window.setTimeout(() => show('side'), 160)
    }
    setNow((before) => (sameDrawing(before, m) ? before : m))
  })

  // At work: the place's pose, or two taking turns.
  const work = workAt(now.place, now.work)
  const poses = now.working ? work.poses.join(' ') : ''
  useEffect(() => {
    if (!poses) return
    window.clearTimeout(rest.current)
    const turns = poses.split(' ') as Pose[]
    let i = 0
    show(turns[0]!, 1)
    if (turns.length < 2) return
    const timer = window.setInterval(() => show(turns[++i % turns.length]!, 1), 220)
    return () => window.clearInterval(timer)
  }, [poses])

  useEffect(() => {
    for (const a of Object.values(art)) new Image().src = a.src
    show('side', 1)
  }, [])

  return (
    // The story's length: a screen to hold the field, and most of one more for each step.
    <div ref={track} className="relative" style={{ height: `${100 + PLACES.length * 80}svh` }}>
      <div className="sticky top-16 flex h-[calc(100svh-4rem)] flex-col justify-center gap-5 py-4">
        <div ref={stage} aria-hidden="true" className="relative h-[264px] shrink-0 overflow-hidden border-2 border-bark-900 bg-[#9fc6d9] shadow-hard-lg lg:h-[396px]">
          <div className="absolute top-0 left-0 origin-top-left" style={{ width: FIELD.w, height: FIELD.h, scale: k }}>
            <Sky camera={camera} />
            <Hills camera={camera} />
            <Pass camera={camera} pace={PACE.back}>
              {BACK.map((b) => (
                <Sprite key={b.name} art={art[b.name]} x={b.x} y={74} className="scale-75 brightness-95 saturate-75" />
              ))}
            </Pass>
            <Pass camera={camera} pace={PACE.field}>
              <Ground />
              {PLACES.map((place, i) => (
                <Spot key={i} place={place} index={i} now={now} art={art} />
              ))}
              <motion.div className="absolute top-0 left-0" style={{ x: at, y: FIELD.path }}>
                <img ref={helper} src={art.side.src} alt="" className="absolute max-w-none pixelated" style={{ left: -art.side.ax, top: -art.side.ay }} />
                <AnimatePresence>{now.working && work.bubble && <Pop key={work.bubble} art={art[work.bubble]} x={0} y={-62} />}</AnimatePresence>
              </motion.div>
            </Pass>
            <Pass camera={camera} pace={PACE.near}>
              {/* Low and small: they brush past the helper's feet, never over what it is doing. */}
              {NEAR.map((n, i) => (
                <Sprite key={i} art={art[n.name]} x={n.x} y={FIELD.h + 30} className="scale-55 brightness-75" />
              ))}
            </Pass>
          </div>
        </div>
        <Branch copy={copy.git} now={now} check={art['mark-check'].src} />
        <Caption copy={copy} icons={icons} now={now} />
      </div>
    </div>
  )
}

/** The words for the step the story is at, with the four steps as marks along the top. */
function Caption({ copy, icons, now }: { copy: Copy['how']; icons: string[]; now: Moment }) {
  const step = copy.steps[now.place]!
  return (
    <div className="relative min-h-44 panel px-5 pt-4 pb-5">
      <ol role="list" className="mb-3 flex flex-wrap gap-2">
        {copy.steps.map((s, i) => (
          <li
            key={i}
            aria-current={i === now.place ? 'step' : undefined}
            className={cx(
              'border-2 border-bark-900 px-2 py-1 font-pixel text-base/none transition-colors duration-300 ease-[steps(3)]',
              i < now.place ? 'bg-leaf-500 text-cream-50' : i === now.place ? 'bg-wheat' : 'bg-cream-100 text-bark-500',
            )}
          >
            {i + 1} {s.title}
          </li>
        ))}
      </ol>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={now.place}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.24, ease: steps(4) }}
          className="flex items-start gap-4"
        >
          <img src={icons[now.place]} alt="" className="size-12 flex-none object-contain pixelated" />
          <div>
            <h3 className="mb-1 text-2xl">{step.title}</h3>
            <p className="text-base text-bark-800">{step.text}</p>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/** A layer of the field passing the camera at its pace (the field itself at 1). */
function Pass({ camera, pace, children }: { camera: MotionValue<number>; pace: number; children: ReactNode }) {
  const x = useTransform(camera, (c) => -c * pace)
  return (
    <motion.div className="absolute inset-0" style={{ x }}>
      {children}
    </motion.div>
  )
}

/** The sky, barely moving, with a cloud or two drifting across. */
function Sky({ camera }: { camera: MotionValue<number> }) {
  return (
    <>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#7fb6dc_0%,#a9d2e6_45%,#d5ead9_70%)]" />
      <Pass camera={camera} pace={PACE.sky}>
        {[
          { y: 8, w: 46, d: 70, delay: -10 },
          { y: 20, w: 30, d: 95, delay: -60 },
        ].map((c, i) => (
          <span
            key={i}
            className="absolute left-0 h-2.5 animate-cloud rounded-[3px] bg-cream-50/90 shadow-[4px_3px_0_rgb(255_255_255/0.6),-5px_4px_0_rgb(255_255_255/0.5)]"
            style={{ top: c.y, width: c.w, animationDuration: `${c.d}s`, animationDelay: `${c.delay}s` }}
          />
        ))}
      </Pass>
    </>
  )
}

/** Two bands of rolling hills, in steps of an art pixel. */
function Hills({ camera }: { camera: MotionValue<number> }) {
  const band = (top: number, rise: number, length: number, seed: number) => {
    const points: string[] = [`0,${FIELD.h}`]
    for (let x = 0; x <= FIELD.w; x += 4) {
      const y = Math.round(top - rise * (0.5 + 0.5 * Math.sin(x / length + seed)) - 3 * Math.sin(x / 13 + seed * 2))
      points.push(`${x},${y}`, `${x + 4},${y}`)
    }
    points.push(`${FIELD.w},${FIELD.h}`)
    return points.join(' ')
  }
  return (
    <>
      <Pass camera={camera} pace={PACE.hills * 0.6}>
        <svg className="absolute inset-0" width={FIELD.w} height={FIELD.h} shapeRendering="crispEdges">
          <polygon points={band(60, 16, 70, 1)} fill="#8db5a0" />
        </svg>
      </Pass>
      <Pass camera={camera} pace={PACE.hills}>
        <svg className="absolute inset-0" width={FIELD.w} height={FIELD.h} shapeRendering="crispEdges">
          <polygon points={band(76, 10, 46, 3)} fill="#7aa95a" />
        </svg>
      </Pass>
    </>
  )
}

/** The field's ground: grass to the bottom, and the path the helper walks. */
function Ground() {
  return (
    <>
      <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,#8fbf5a,#76a046)]" style={{ top: 74 }} />
      <div
        className="absolute inset-x-0 border-y border-path-edge bg-[repeating-linear-gradient(90deg,var(--color-path)_0_11px,var(--color-path-groove)_11px_13px)]"
        style={{ top: FIELD.path - 9, height: 14 }}
      />
    </>
  )
}

/** A picture standing on the field at x, its feet at y. */
function Sprite({ art, x, y, className }: { art: Art; x: number; y: number; className?: string }) {
  return (
    <img
      src={art.src}
      alt=""
      className={cx('absolute max-w-none origin-bottom pixelated', className)}
      style={{ left: x - art.ax, top: y - art.ay, width: art.w, height: art.h }}
    />
  )
}

/** One place: its thing, its plot at the stage the story has it at, and what turns up there. */
function Spot({ place, index, now, art }: { place: (typeof PLACES)[number]; index: number; now: Moment; art: StoryArt }) {
  const stage = stageOf(index, now)
  const here = now.place === index && now.working
  const done = now.place > index
  return (
    <>
      <Sprite art={art[place.thing.name]} x={place.thing.x} y={FIELD.stand} />
      <motion.div
        key={stage}
        className="absolute top-0 left-0"
        initial={{ scale: 0.7 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.3, ease: steps(3) }}
        style={{ x: place.plot, y: FIELD.stand, originX: 0.5, originY: 1 }}
      >
        <Sprite art={art[stage]} x={0} y={0} />
      </motion.div>
      <AnimatePresence>
        {/* Say it: the owner's words, over the board. */}
        {index === 0 && here && now.work > 0.12 && now.work < 0.5 && <Pop key="said" art={art['act-speaking_text']} x={place.thing.x} y={FIELD.stand - 66} />}
        {/* Harvest: coins up from the wheat, then the stamp. */}
        {index === 3 && here && now.work > 0.45 && (
          <motion.div
            key="coins"
            className="absolute top-0 left-0"
            initial={{ opacity: 0, y: FIELD.stand - 46 }}
            animate={{ opacity: [0, 1, 1, 0], y: FIELD.stand - 86 }}
            transition={{ duration: 1.4, ease: steps(7) }}
            style={{ x: place.plot }}
          >
            <Sprite art={art['coins-stack']} x={0} y={0} className="scale-50" />
          </motion.div>
        )}
        {index === 3 && (done || (here && now.work > 0.75)) && (
          <motion.div
            key="stamp"
            className="absolute top-0 left-0"
            initial={{ scale: 1.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.25, ease: steps(3) }}
            style={{ x: place.plot + 24, y: FIELD.stand - 34 }}
          >
            <Sprite art={art['stamp-done']} x={0} y={0} className="scale-50" />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** A bubble popping up at x, y with a picture in it. */
function Pop({ art, x, y }: { art: Art; x: number; y: number }) {
  return (
    <motion.div
      className="absolute top-0 left-0"
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{ duration: 0.22, ease: steps(3) }}
      style={{ x, y, originY: 1 }}
    >
      <div className="absolute bottom-0 left-0 -translate-x-1/2 border border-bark-900 bg-cream-50 p-0.5 shadow-[1px_1px_0_var(--color-drop)]">
        <img src={art.src} alt="" className="block max-w-none pixelated" style={{ width: Math.round(art.w * 0.55), height: Math.round(art.h * 0.55) }} />
      </div>
    </motion.div>
  )
}

/** Where the branch's marks sit across the picture (shares of its width). */
const GIT = { fork: 0.16, commits: [0.36, 0.5, 0.64], join: 0.84 } as const

/** The job's branch at a moment of the story, as a git graph: main along the bottom; the helper's branch forking up off
 *  it when the work is handed out, its commits popping on as it works, and joining main again at the harvest; its
 *  counters (commits, lines, tests) above. */
function Branch({ copy, now, check }: { copy: Copy['how']['git']; now: Moment; check: string }) {
  const b = branchAt(now)
  const lane = 30
  const main = 74
  const head = b.merged ? GIT.join - 0.06 : b.commits > 0 ? GIT.commits[b.commits - 1]! : GIT.fork + 0.08
  const path = b.forked ? `M${GIT.fork * 100},${main} L${(GIT.fork + 0.06) * 100},${lane} L${head * 100},${lane}${b.merged ? ` L${GIT.join * 100},${main}` : ''}` : ''
  return (
    <div className="relative panel px-4 pt-3 pb-2" aria-hidden="true">
      <div className="flex flex-wrap items-center gap-2 font-pixel text-sm/none sm:text-base/none">
        <span className={cx('border-2 border-bark-900 px-2 py-1', b.forked ? 'bg-leaf-300' : 'bg-cream-100 text-bark-500')}>
          {copy.branch}
          <span className="hidden sm:inline"> · {copy.worktree}</span>
        </span>
        <span className="ml-auto border-2 border-bark-900 bg-cream-100 px-2 py-1 tabular-nums">
          {b.commits} {copy.commits}
        </span>
        <span className="border-2 border-bark-900 bg-cream-100 px-2 py-1 tabular-nums">
          <span className="text-leaf-700">+{b.plus}</span> <span className="text-berry">−{b.minus}</span>
        </span>
        <span className={cx('border-2 border-bark-900 px-2 py-1 tabular-nums', b.tests === JOB.tests ? 'bg-leaf-500 text-cream-50' : 'bg-cream-100')}>
          {copy.tests} {b.tests}/{JOB.tests}
        </span>
      </div>
      <div className="relative mt-1 h-[92px]">
        <svg className="absolute inset-0 size-full" viewBox="0 0 100 92" preserveAspectRatio="none" shapeRendering="crispEdges">
          <line x1="0" y1={main} x2="100" y2={main} stroke="var(--color-bark-900)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          {path && <path d={path} fill="none" stroke="var(--color-leaf-600)" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="absolute left-0 font-pixel text-sm/none text-bark-800" style={{ top: main - 22 }}>
          main
        </span>
        <Dot x={GIT.fork} y={main} shown={b.forked} tone="bg-bark-900" />
        {GIT.commits.map((x, i) => (
          <Dot key={i} x={x} y={lane} shown={b.commits > i} tone="bg-leaf-500" />
        ))}
        <Dot x={GIT.join} y={main} shown={b.merged} tone="bg-wheat" large />
        <AnimatePresence>
          {b.merged && (
            <motion.span
              key="merged"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: steps(3) }}
              className="absolute flex -translate-x-1/2 items-center gap-1 border-2 border-bark-900 bg-wheat px-1.5 py-0.5 font-pixel text-sm/none whitespace-nowrap"
              style={{ left: `${GIT.join * 100}%`, top: main - 42 }}
            >
              {copy.merged}
              <img src={check} alt="" className="size-3.5 object-contain pixelated" />
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** A commit on the graph: a square that pops on when it is made. */
function Dot({ x, y, shown, tone, large }: { x: number; y: number; shown: boolean; tone: string; large?: boolean }) {
  return (
    <AnimatePresence>
      {shown && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ duration: 0.18, ease: steps(3) }}
          className={cx('absolute -translate-1/2 border-2 border-bark-900', large ? 'size-4' : 'size-3', tone)}
          style={{ left: `${x * 100}%`, top: y }}
        />
      )}
    </AnimatePresence>
  )
}
