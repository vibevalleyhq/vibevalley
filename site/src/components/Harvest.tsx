// The morning after the hero's night: the harvest is in (copy.harvest, rhyming with the hero's verse). Big over a golden
// field, rows of ripe plots sliding past the other way from each other as the band crosses the screen
// (useScrollLinked), a few coins bobbing by the words.
import type { Copy } from '../i18n/zh'
import { JOB } from '../lib/story'
import { CountUp, useOffScreen, useReveal, useScrollLinked } from './ui'

/** While the band crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING = ['start end', 'end start'] as ['start end', 'end start']

interface Props {
  copy: Copy['harvest']
  /** The ripe plots, the row behind and the row in front. */
  rows: [string[], string[]]
  coins: string
  /** The harvest list's icon and its check. */
  icons: { harvest: string; check: string }
}

export default function Harvest({ copy, rows, coins, icons }: Props) {
  const ref = useReveal<HTMLElement>()
  const back = useScrollLinked<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ['translateX(-50px)', 'translateX(50px)'] } }])
  const front = useScrollLinked<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ['translateX(110px)', 'translateX(-110px)'] } }])
  useOffScreen(ref)
  return (
    <section
      ref={ref}
      id="harvest"
      aria-labelledby="harvest-title"
      className="relative overflow-hidden border-y-2 border-bark-900 bg-[linear-gradient(180deg,#f6dc94_0%,#eab654_55%,#c98d32_100%)] px-4 py-[clamp(96px,13vw,170px)]"
    >
      <div ref={back} aria-hidden="true" className="absolute top-[6%] left-[-10%] flex w-[120%] items-end gap-5 opacity-60">
        {rows[0].map((src, i) => (
          <img key={i} loading="lazy" src={src} alt="" className="w-[68px] max-w-none pixelated sm:w-[102px]" />
        ))}
      </div>
      <div ref={front} aria-hidden="true" className="absolute bottom-[-4%] left-[-10%] flex w-[120%] items-end gap-6">
        {rows[1].map((src, i) => (
          <img key={i} loading="lazy" src={src} alt="" className="w-[102px] max-w-none pixelated sm:w-[136px]" />
        ))}
      </div>
      {/* A shade behind the words, so they read over the field. */}
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(ellipse_60%_55%_at_50%_50%,rgb(30_20_10/0.55),transparent_75%)]" />
      <div className="relative mx-auto max-w-[920px] text-center text-cream-50">
        <div aria-hidden="true" className="mb-4 flex justify-center gap-3">
          {[0, 1, 2].map((i) => (
            <img key={i} loading="lazy" src={coins} alt="" className="w-9 pixelated motion-safe:animate-float sm:w-11" style={{ animationDelay: `${i * -1.6}s` }} />
          ))}
        </div>
        <h2 id="harvest-title" data-reveal className="text-[clamp(40px,8vw,104px)]/[1.2] text-shadow-title">
          {copy.title.map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </h2>
        <p data-reveal={120} className="mx-auto mt-5 max-w-[34em] text-lg text-balance text-shadow-thin sm:text-xl">
          {copy.text}
        </p>
        <HarvestList copy={copy.card} icons={icons} />
      </div>
    </section>
  )
}

/** The story's job as the app's harvest list shows it: its commits, files and lines, counting up as it comes on screen,
 *  no conflicts, and the button that brings it in (here a picture of it). */
function HarvestList({ copy, icons }: { copy: Copy['harvest']['card']; icons: { harvest: string; check: string } }) {
  return (
    <div data-reveal={240} className="mx-auto mt-9 w-[min(480px,100%)] panel p-4 text-left text-bark-900">
      <div className="flex items-center gap-2.5">
        <img src={icons.harvest} alt="" className="size-8 object-contain pixelated" />
        <div className="min-w-0">
          <p className="font-pixel text-lg/none">{copy.title}</p>
          <p className="mt-1 truncate text-sm text-bark-800">{copy.job}</p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt className="sr-only">{copy.commits}</dt>
          <dd className="font-pixel text-3xl/none">
            <CountUp to={JOB.commits} />
          </dd>
          <dd className="mt-1 text-xs text-bark-800">{copy.commits}</dd>
        </div>
        <div className="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt className="sr-only">{copy.files}</dt>
          <dd className="font-pixel text-3xl/none">
            <CountUp to={JOB.files} />
          </dd>
          <dd className="mt-1 text-xs text-bark-800">{copy.files}</dd>
        </div>
        <div className="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt className="sr-only">{copy.lines}</dt>
          <dd className="font-pixel text-xl/none whitespace-nowrap sm:text-2xl/none">
            <span className="text-leaf-700">
              +<CountUp to={JOB.plus} />
            </span>{' '}
            <span className="text-berry">
              −<CountUp to={JOB.minus} />
            </span>
          </dd>
          <dd className="mt-1 text-xs text-bark-800">{copy.lines}</dd>
        </div>
      </dl>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm text-leaf-700">
          <img src={icons.check} alt="" className="size-4 object-contain pixelated" />
          {copy.clean}
        </span>
        <span className="border-2 border-bark-900 bg-leaf-500 px-3 py-1.5 font-pixel text-base/none text-cream-50 inset-shadow-lit inset-shadow-leaf-hover shadow-hard-sm">
          {copy.take}
        </span>
      </div>
    </div>
  )
}
