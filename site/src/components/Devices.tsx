// Every screen the farm is on: the app on the Mac that runs the farm, and on phones that join it through the
// yard gate. A Mac with the farm, two phones in front of its lower right with the farm chat and the tickets, each
// drifting at its own pace as the page scrolls (useScrollLinked); side by side under the Mac on a narrow screen.
import type { ReactNode } from 'react'
import type { Copy } from '../i18n/zh'
import { Section, cx, useReveal, useScrollLinked } from './ui'

interface Shot {
  src: string
  srcset: string
  width: number
  height: number
}

interface Props {
  copy: Copy['devices']
  mac: Shot
  phones: [Shot, Shot]
}

export default function Devices({ copy, mac, phones }: Props) {
  const root = useReveal<HTMLElement>()
  return (
    <Section ref={root} id="devices" title={copy.title}>
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div>
          <p data-reveal className="max-w-[36em]">
            {copy.text}
          </p>
          <ul role="list" data-reveal className="mt-6 flex flex-wrap gap-3">
            {copy.platforms.map((p) => (
              <li key={p} className="panel px-3.5 py-2 font-pixel text-lg/none">
                {p}
              </li>
            ))}
          </ul>
          <p data-reveal className="mt-5 text-[15px] text-bark-800">
            {copy.note}
          </p>
        </div>
        <div className="relative mx-auto w-full max-w-[640px] lg:pb-24">
          <Drift rate={0.03}>
            <Laptop shot={mac} alt={copy.shots.mac} />
          </Drift>
          <div className="mt-8 flex justify-center gap-6 lg:mt-0">
            <Drift rate={-0.06} className="w-[42%] max-w-[180px] lg:absolute lg:right-[17%] lg:bottom-[-4px] lg:w-[25%]">
              <Phone shot={phones[0]} alt={copy.shots.chat} />
            </Drift>
            <Drift rate={-0.11} className="w-[42%] max-w-[180px] lg:absolute lg:right-[-7%] lg:bottom-[-44px] lg:w-[25%]">
              <Phone shot={phones[1]} alt={copy.shots.tickets} />
            </Drift>
          </div>
        </div>
      </div>
    </Section>
  )
}

/** A device's place on the page, moving against the page by its rate while it crosses the screen. */
function Drift({ rate, className, children }: { rate: number; className?: string; children: ReactNode }) {
  const ref = useScrollLinked<HTMLDivElement>('self', ['start end', 'end start'], () => [
    { keyframes: { transform: [`translateY(${600 * rate}px)`, `translateY(${-600 * rate}px)`] } },
  ])
  return (
    <div ref={ref} className={cx('relative', className)}>
      {children}
    </div>
  )
}

/** A Mac in the farm's colours: the screen in a dark frame, a strip of a base under it. */
function Laptop({ shot, alt }: { shot: Shot; alt: string }) {
  return (
    <div>
      <div className="border-[6px] border-bark-900 bg-bark-900 shadow-hard-lg">
        <img
          loading="lazy"
          decoding="async"
          src={shot.src}
          srcSet={shot.srcset}
          sizes="(min-width: 1024px) 620px, calc(100vw - 48px)"
          width={shot.width}
          height={shot.height}
          alt={alt}
          className="block h-auto w-full"
        />
      </div>
      <div className="mx-[-4%] h-3 border-2 border-bark-900 bg-cream-300 shadow-hard" />
    </div>
  )
}

/** A phone in the farm's colours: the screen in a thick dark frame. */
function Phone({ shot, alt }: { shot: Shot; alt: string }) {
  return (
    <div className="rounded-[18px] border-[7px] border-bark-900 bg-bark-900 shadow-hard-lg">
      <img loading="lazy" decoding="async" src={shot.src} width={shot.width} height={shot.height} alt={alt} className="block h-auto w-full rounded-[10px]" />
    </div>
  )
}
