// The helpers on their way to work: a row of plots behind, the path they walk, plants in front. The rows slide at
// their own pace as the section crosses the screen (useScrollLinked); the helpers walk across at theirs (CSS, so they
// walk without the script too).
import type { Copy } from '../i18n/zh'
import { useOffScreen, useReveal, useScrollLinked } from './ui'

/** While the section crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING = ['start end', 'end start'] as ['start end', 'end start']

interface Props {
  copy: Copy['parade']
  /** The plots behind, left to right. */
  plots: string[]
  /** Each helper's side frames in a step: step, stand, step, stand. */
  walkers: string[][]
  /** The plants in front. */
  front: string[]
}

export default function Parade({ copy, plots, walkers, front }: Props) {
  const ref = useReveal<HTMLElement>()
  // The plots slide left by 120 px as the section crosses the screen, the plants in front right by 300.
  const back = useScrollLinked<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ['translateX(60px)', 'translateX(-60px)'] } }])
  const near = useScrollLinked<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ['translateX(-150px)', 'translateX(150px)'] } }])
  useOffScreen(ref)
  return (
    <>
      <section
        ref={ref}
        id="parade"
        aria-labelledby="parade-title"
        className="relative h-[400px] overflow-hidden border-y-2 border-bark-900 [container-type:inline-size] bg-[linear-gradient(180deg,#9fc6d9_0%,#cfe3d6_49%,#7fa84e_49%,#6b9241_100%)]"
      >
        <div ref={back} aria-hidden="true" className="absolute bottom-[108px] left-[-10%] flex w-[120%] items-end gap-6">
          {plots.map((src, i) => (
            <img loading="lazy" key={i} src={src} alt="" className="w-[102px] max-w-none pixelated" />
          ))}
        </div>
        <div
          aria-hidden="true"
          className="absolute bottom-[38px] h-16 w-full border-y-2 border-path-edge bg-[repeating-linear-gradient(90deg,var(--color-path)_0_22px,var(--color-path-groove)_22px_26px)]"
        />
        {walkers.map((frames, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="absolute bottom-[54px] left-0 h-[84px] w-12 animate-walk"
            style={{ animationDuration: `${26 + (i % 3) * 7}s`, animationDelay: `${-i * 5.3}s` }}
          >
            {frames.map((src, j) => (
              <img
                key={j}
                src={src}
                alt=""
                loading="lazy"
                className="absolute inset-0 size-full animate-walk-frame object-contain object-bottom opacity-0 pixelated"
                style={{ animationDelay: `${j * 0.15}s` }}
              />
            ))}
          </div>
        ))}
        <div ref={near} aria-hidden="true" className="absolute bottom-[-18px] left-[-10%] flex w-[120%] items-end gap-[120px]">
          {front.map((src, i) => (
            <img loading="lazy" key={i} src={src} alt="" className="w-[150px] max-w-none pixelated" />
          ))}
        </div>
        <div data-reveal className="absolute inset-x-0 top-[22px] z-2 mx-auto w-[min(760px,calc(100%-32px))] panel px-[22px] py-3.5 text-center">
          <h2 id="parade-title" className="text-2xl sm:text-[30px]">
            {copy.title}
          </h2>
          <p className="mt-1.5 text-sm sm:text-base">{copy.text}</p>
        </div>
      </section>
    </>
  )
}
