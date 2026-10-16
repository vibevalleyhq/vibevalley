// What the farm does: its numbers counting up like a game's tallies (lib/facts.ts), then card by card, and the
// machines its helpers drive. Cards come in one after another along a row; under the pointer a card lifts a little and
// its icon gives a wiggle.
import type { Copy } from '../i18n/zh'
import { FACTS } from '../lib/facts'
import { CountUp, Heading, Section, useReveal } from './ui'

interface Props {
  copy: Pick<Copy, 'features' | 'runtimes'>
  /** Each card's icon. */
  icons: string[]
  /** The machines, by name and pixel logo, VibeValley's own last. */
  runtimes: { name: string; logo: string }[]
  /** Each of the farm's numbers' picture (lib/facts.ts), in its order. */
  tallies: string[]
}

export default function Features({ copy, icons, runtimes, tallies }: Props) {
  const root = useReveal<HTMLElement>()
  return (
    <Section ref={root} id="features" alt title={copy.features.title}>
      <ul role="list" className="mb-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {FACTS.map((f, i) => (
          <li key={f.key} data-reveal={(i % 6) * 60} className="flex flex-col items-center panel px-2 pt-3 pb-2.5 text-center">
            <img loading="lazy" src={tallies[i]} alt="" className="mb-2 h-10 w-auto max-w-full object-contain pixelated" />
            <span className="font-pixel text-4xl/none">
              <CountUp to={f.n} />
            </span>
            <span className="mt-1.5 text-[13px]/snug text-balance text-bark-800">{copy.features.tally[f.key]}</span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-4">
        {copy.features.items.map((f, i) => (
          <article key={f.title} data-reveal={(i % 4) * 70} className="group panel p-[22px] transition-[translate] duration-150 ease-[steps(2)] hover:-translate-y-1">
            <img loading="lazy" src={icons[i]} alt="" className="mb-3 size-11 object-contain pixelated group-hover:animate-wiggle" />
            <h3 className="mb-1.5 text-2xl">{f.title}</h3>
            <p className="text-base text-bark-800">{f.text}</p>
          </article>
        ))}
      </div>
      <Heading className="mt-[72px]">{copy.runtimes.title}</Heading>
      <p data-reveal className="max-w-[44em]">
        {copy.runtimes.text}
      </p>
      <div className="mt-7 flex flex-wrap gap-[18px]">
        {runtimes.map((r, i) => (
          <span key={r.name} data-reveal={i * 90} className="group flex items-center gap-3 panel px-[18px] py-3 font-pixel text-2xl/none">
            <img loading="lazy" src={r.logo} alt="" className="size-10 object-contain pixelated group-hover:animate-wiggle" />
            {r.name}
          </span>
        ))}
      </div>
    </Section>
  )
}
