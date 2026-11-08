import { createReveal } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { FACTS } from "../lib/facts";
import { CountUp, Heading, Section } from "./ui";
interface Props {
  copy: Pick<Copy, "features" | "runtimes">;
  /** Each card's icon. */
  icons: string[];
  /** The machines, by name and pixel logo, VibeValley's own last. */
  runtimes: {
    name: string;
    logo: string;
  }[];
  /** Each of the farm's numbers' picture (lib/facts.ts), in its order. */
  tallies: string[];
}
export default function Features(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="features" alt title={props.copy.features.title}>
      <ul role="list" class="mb-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {FACTS.map((f, i) => (
          <li data-reveal={(i % 6) * 60} class="panel flex flex-col items-center px-2 pt-3 pb-2.5 text-center">
            <img loading="lazy" src={props.tallies[i]} alt="" class="pixelated mb-2 h-10 w-auto max-w-full object-contain" />
            <span class="font-pixel text-4xl/none">
              <CountUp to={f.n} />
            </span>
            <span class="mt-1.5 text-[13px]/snug text-balance text-bark-800">{props.copy.features.tally[f.key]}</span>
          </li>
        ))}
      </ul>
      <div class="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-4">
        {props.copy.features.items.map((f, i) => (
          <article data-reveal={(i % 4) * 70} class="group panel p-[22px] transition-[translate] duration-150 ease-[steps(2)] hover:-translate-y-1">
            <img loading="lazy" src={props.icons[i]} alt="" class="pixelated group-hover:animate-wiggle mb-3 size-11 object-contain" />
            <h3 class="mb-1.5 text-2xl">{f.title}</h3>
            <p class="text-base text-bark-800">{f.text}</p>
          </article>
        ))}
      </div>
      <Heading className="mt-[72px]">{props.copy.runtimes.title}</Heading>
      <p data-reveal class="max-w-[44em]">
        {props.copy.runtimes.text}
      </p>
      <div class="mt-7 flex flex-wrap gap-[18px]">
        {props.runtimes.map((r, i) => (
          <span data-reveal={i * 90} class="group panel flex items-center gap-3 px-[18px] py-3 font-pixel text-2xl/none">
            <img loading="lazy" src={r.logo} alt="" class="pixelated group-hover:animate-wiggle size-10 object-contain" />
            {r.name}
          </span>
        ))}
      </div>
    </Section>
  );
}
