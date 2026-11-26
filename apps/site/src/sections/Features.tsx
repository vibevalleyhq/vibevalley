import { FACTS } from "../base/facts";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { Icon } from "../ui/icons";
import { createReveal } from "../ui/scroll";
import { CountUp, Heading, Section } from "../ui/ui";

interface Props {
  copy: Pick<Copy, "features" | "runtimes">;
  /** VibeValley's own runtime comes last. */
  runtimes: {
    name: string;
    logo: string;
  }[];
  /** Each of the farm's numbers' Papertrails illustration (src/base/facts.ts), in order. */
  tallies: { src: string; framed: boolean }[];
}

export default function Features(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="features" alt title={props.copy.features.title}>
      <ul role="list" class="mb-12 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        {FACTS.map((f, i) => {
          const tally = props.tallies[i];
          return (
            <li
              data-reveal={(i % 6) * 60}
              class="flex flex-col items-center rounded-md border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] px-2.5 pt-3.5 pb-3 text-center"
            >
              <img
                loading="lazy"
                src={tally?.src}
                alt=""
                class={["mb-2.5 h-11 w-11 object-contain", tally?.framed === true && "rounded-sm border border-border-soft/35 object-cover shadow-card-sm"]}
              />
              <span class="font-display text-3xl font-bold leading-none text-bark-900">
                <CountUp to={f.n} />
              </span>
              <span class="mt-1.5 text-[length:13px] leading-snug text-balance text-bark-800">{props.copy.features.tally[f.key]}</span>
            </li>
          );
        })}
      </ul>
      <div class="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-4 gap-5.5">
        {props.copy.features.items.map((f, i) => (
          <article
            data-reveal={(i % 4) * 70}
            class="group/feature-card rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] p-5.5 transition-[transform,box-shadow] ease-out duration-200 hover:-translate-y-1 hover:shadow-card-lg"
          >
            <span class="mb-3.5 grid h-11 w-11 place-items-center rounded-md border border-border-soft/35 bg-cream-100 text-bark-800 transition-[background-color,color] ease-out duration-200 group-hover/feature-card:bg-leaf-300/60 group-hover/feature-card:text-leaf-700">
              <Icon name={f.icon} class="h-5.5 w-5.5" />
            </span>
            <h3 class="mb-1.5 text-xl">{f.title}</h3>
            <p class="text-[length:15px] leading-relaxed text-bark-800">{f.text}</p>
          </article>
        ))}
      </div>
      <Heading class="mt-18">{props.copy.runtimes.title}</Heading>
      <p data-reveal class="max-w-[44em] text-bark-800">
        {props.copy.runtimes.text}
      </p>
      <div class="mt-7 flex flex-wrap gap-4">
        {props.runtimes.map((r, i) => (
          <span
            data-reveal={i * 90}
            class="flex items-center gap-3 rounded-md border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] px-4.5 py-3 font-sans text-lg font-semibold leading-none text-bark-900 transition-[transform,box-shadow] ease-out duration-200 hover:-translate-y-0.5 hover:shadow-card-lg"
          >
            <img loading="lazy" src={r.logo} alt="" class="w-10 h-10 object-contain" />
            {r.name}
          </span>
        ))}
      </div>
    </Section>
  );
}
