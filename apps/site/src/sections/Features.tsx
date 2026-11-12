import { FACTS } from "../base/facts";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { createReveal } from "../ui/scroll";
import { CountUp, Heading, Section } from "../ui/ui";

interface Props {
  copy: Pick<Copy, "features" | "runtimes">;
  icons: string[];
  /** VibeValley's own runtime comes last. */
  runtimes: {
    name: string;
    logo: string;
  }[];
  /** Each of the farm's numbers' picture (src/base/facts.ts), in its order. */
  tallies: string[];
}
export default function Features(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="features" alt title={props.copy.features.title}>
      <ul role="list" class="mb-12 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {FACTS.map((f, i) => (
          <li
            data-reveal={(i % 6) * 60}
            class="flex flex-col items-center border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] px-2 pt-3 pb-2.5 text-center"
          >
            <img loading="lazy" src={props.tallies[i]} alt="" class="mb-2 h-10 w-auto max-w-full object-contain [image-rendering:pixelated]" />
            <span class="font-pixel text-4xl leading-none">
              <CountUp to={f.n} />
            </span>
            <span class="mt-1.5 text-[length:13px] leading-snug text-balance text-bark-800">{props.copy.features.tally[f.key]}</span>
          </li>
        ))}
      </ul>
      <div class="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-4 gap-5.5">
        {props.copy.features.items.map((f, i) => (
          <article
            data-reveal={(i % 4) * 70}
            class={[
              "group/feature-card",
              "border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] p-5.5 transition-[translate] ease-[steps(2,end)] duration-150 hover:[translate:0_-0.25rem]",
            ]}
          >
            <img
              loading="lazy"
              src={props.icons[i]}
              alt=""
              class={[
                "mb-3 w-11 h-11 object-contain [image-rendering:pixelated]",
                "group-hover/feature-card:[animation-name:wiggle] group-hover/feature-card:[animation-duration:400ms] group-hover/feature-card:[animation-timing-function:steps(4)]",
              ]}
            />
            <h3 class="mb-1.5 text-2xl">{f.title}</h3>
            <p class="text-base text-bark-800">{f.text}</p>
          </article>
        ))}
      </div>
      <Heading class="mt-18">{props.copy.runtimes.title}</Heading>
      <p data-reveal class="max-w-[44em]">
        {props.copy.runtimes.text}
      </p>
      <div class="mt-7 flex flex-wrap gap-4.5">
        {props.runtimes.map((r, i) => (
          <span
            data-reveal={i * 90}
            class={[
              "group/feature-card",
              "flex items-center gap-3 border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] px-4.5 py-3 font-pixel text-2xl leading-none",
            ]}
          >
            <img
              loading="lazy"
              src={r.logo}
              alt=""
              class={[
                "w-10 h-10 object-contain [image-rendering:pixelated]",
                "group-hover/feature-card:[animation-name:wiggle] group-hover/feature-card:[animation-duration:400ms] group-hover/feature-card:[animation-timing-function:steps(4)]",
              ]}
            />
            {r.name}
          </span>
        ))}
      </div>
    </Section>
  );
}
