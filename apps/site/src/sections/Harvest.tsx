import { JOB } from "../base/story";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { Icon } from "../ui/icons";
import { observeVisibility, createReveal, createScrollAnimation } from "../ui/scroll";
import { CountUp } from "../ui/ui";

/** While the band crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING: ["start end", "end start"] = ["start end", "end start"];
interface Props {
  copy: Copy["harvest"];
  /** The ripe Papertrails plots, the row behind and the row in front. */
  rows: [string[], string[]];
  lantern: string;
}
export default function Harvest(props: Props) {
  const ref = createReveal<HTMLElement>();
  const back = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(-50px)", "translateX(50px)"] } }]);
  const front = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(110px)", "translateX(-110px)"] } }]);
  observeVisibility(ref);
  return (
    <section
      ref={ref.set}
      id="harvest"
      aria-labelledby="harvest-title"
      class="relative overflow-hidden border-y border-border-soft/40 bg-[image:var(--scene-harvest-background)] px-4 py-[clamp(96px,13vw,170px)]"
    >
      <div ref={back.set} aria-hidden="true" class="absolute top-[5%] -left-[10%] flex w-[120%] items-end gap-5 opacity-55">
        {props.rows[0].map((src) => (
          <img loading="lazy" src={src} alt="" class="w-22 sm:w-28 max-w-none" />
        ))}
      </div>
      <div ref={front.set} aria-hidden="true" class="absolute -bottom-[5%] -left-[10%] flex w-[120%] items-end gap-6">
        {props.rows[1].map((src) => (
          <img loading="lazy" src={src} alt="" class="w-28 sm:w-36 max-w-none drop-shadow-[0_6px_12px_rgb(91_67_43_/_0.25)]" />
        ))}
      </div>
      {/* Keep editorial text legible over the golden wheat band. */}
      <div aria-hidden="true" class="absolute inset-0 bg-[image:var(--scene-harvest-shade)]" />
      <div class="relative mx-auto max-w-230 text-center text-paper-core">
        <div aria-hidden="true" class="mb-4 flex justify-center gap-4">
          {[0, 1, 2].map((i) => (
            <img
              loading="lazy"
              src={props.lantern}
              alt=""
              class="h-12 sm:h-14 w-auto drop-shadow-[0_4px_10px_rgb(47_31_19_/_0.35)] motion-safe:[animation-name:title-float] motion-safe:[animation-duration:5000ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite]"
              style={{
                "animation-delay": `${i * -1.6}s`,
              }}
            />
          ))}
        </div>
        <h2 id="harvest-title" data-reveal class="text-[length:clamp(38px,7.2vw,90px)] leading-[1.18] [text-shadow:var(--text-shadow-title)]">
          {props.copy.title.map((line) => (
            <span class="block">{line}</span>
          ))}
        </h2>
        <p data-reveal={120} class="mx-auto mt-5 max-w-[34em] text-lg sm:text-xl text-balance [text-shadow:var(--text-shadow-thin)]">
          {props.copy.text}
        </p>
        <HarvestList copy={props.copy.card} />
      </div>
    </section>
  );
}

function HarvestList(props: { copy: Copy["harvest"]["card"] }) {
  return (
    <div
      data-reveal={240}
      class="mx-auto mt-9 w-[min(480px,100%)] rounded-lg border border-border-soft/55 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card-lg)] p-5 text-left text-bark-900"
    >
      <div class="flex items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-border-soft/35 bg-cream-100 text-leaf-700">
          <Icon name="harvest" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <p class="font-display text-lg font-bold leading-none">{props.copy.title}</p>
          <p class="mt-1 truncate text-sm text-bark-800">{props.copy.job}</p>
        </div>
      </div>
      <dl class="mt-4 grid grid-cols-3 gap-2.5 text-center">
        <div class="rounded-sm border border-border-soft/30 bg-cream-100 px-2 py-2.5">
          <dt class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.commits}</dt>
          <dd class="font-display text-3xl font-bold leading-none">
            <CountUp to={JOB.commits} />
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.commits}</dd>
        </div>
        <div class="rounded-sm border border-border-soft/30 bg-cream-100 px-2 py-2.5">
          <dt class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.files}</dt>
          <dd class="font-display text-3xl font-bold leading-none">
            <CountUp to={JOB.files} />
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.files}</dd>
        </div>
        <div class="rounded-sm border border-border-soft/30 bg-cream-100 px-2 py-2.5">
          <dt class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.lines}</dt>
          <dd class="font-display text-xl sm:text-2xl font-bold leading-none sm:leading-none whitespace-nowrap">
            <span class="text-leaf-700">
              +<CountUp to={JOB.plus} />
            </span>{" "}
            <span class="text-berry">
              −<CountUp to={JOB.minus} />
            </span>
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.lines}</dd>
        </div>
      </dl>
      <div class="mt-4 flex items-center justify-between gap-3">
        <span class="flex items-center gap-1.5 text-sm font-medium text-leaf-700">
          <Icon name="check" class="w-4 h-4" />
          {props.copy.clean}
        </span>
        <span class="rounded-sm border border-leaf-700/80 bg-leaf-500 px-3.5 py-1.5 font-sans text-sm font-semibold leading-none text-paper-core shadow-card-sm">
          {props.copy.take}
        </span>
      </div>
    </div>
  );
}
