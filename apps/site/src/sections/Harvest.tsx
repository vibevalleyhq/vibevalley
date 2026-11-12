import { JOB } from "../base/story";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { observeVisibility, createReveal, createScrollAnimation } from "../ui/scroll";
import { CountUp } from "../ui/ui";

/** While the band crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING: ["start end", "end start"] = ["start end", "end start"];
interface Props {
  copy: Copy["harvest"];
  /** The ripe plots, the row behind and the row in front. */
  rows: [string[], string[]];
  coins: string;
  icons: {
    harvest: string;
    check: string;
  };
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
      class="relative overflow-hidden border-y-2 border-bark-900 bg-[image:var(--scene-harvest-background)] px-4 py-[clamp(96px,13vw,170px)]"
    >
      <div ref={back.set} aria-hidden="true" class="absolute top-[6%] -left-[10%] flex w-[120%] items-end gap-5 opacity-60">
        {props.rows[0].map((src) => (
          <img loading="lazy" src={src} alt="" class="w-17 sm:w-25.5 max-w-none [image-rendering:pixelated]" />
        ))}
      </div>
      <div ref={front.set} aria-hidden="true" class="absolute -bottom-[4%] -left-[10%] flex w-[120%] items-end gap-6">
        {props.rows[1].map((src) => (
          <img loading="lazy" src={src} alt="" class="w-25.5 sm:w-34 max-w-none [image-rendering:pixelated]" />
        ))}
      </div>
      {/* Keep the words readable over the field. */}
      <div aria-hidden="true" class="absolute inset-0 bg-[image:var(--scene-harvest-shade)]" />
      <div class="relative mx-auto max-w-230 text-center text-cream-50">
        <div aria-hidden="true" class="mb-4 flex justify-center gap-3">
          {[0, 1, 2].map((i) => (
            <img
              loading="lazy"
              src={props.coins}
              alt=""
              class="w-9 sm:w-11 [image-rendering:pixelated] motion-safe:[animation-name:title-float] motion-safe:[animation-duration:5000ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:none] motion-safe:[animation-play-state:running]"
              style={{
                "animation-delay": `${i * -1.6}s`,
              }}
            />
          ))}
        </div>
        <h2 id="harvest-title" data-reveal class="text-[length:clamp(40px,8vw,104px)] leading-[1.2] [text-shadow:var(--text-shadow-title)]">
          {props.copy.title.map((line) => (
            <span class="block">{line}</span>
          ))}
        </h2>
        <p data-reveal={120} class="mx-auto mt-5 max-w-[34em] text-lg sm:text-xl text-balance [text-shadow:var(--text-shadow-thin)]">
          {props.copy.text}
        </p>
        <HarvestList copy={props.copy.card} icons={props.icons} />
      </div>
    </section>
  );
}
function HarvestList(props: {
  copy: Copy["harvest"]["card"];
  icons: {
    harvest: string;
    check: string;
  };
}) {
  return (
    <div
      data-reveal={240}
      class="mx-auto mt-9 w-[min(480px,100%)] border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] p-4 text-left text-bark-900"
    >
      <div class="flex items-center gap-2.5">
        <img src={props.icons.harvest} alt="" class="w-8 h-8 object-contain [image-rendering:pixelated]" />
        <div class="min-w-0">
          <p class="font-pixel text-lg leading-none">{props.copy.title}</p>
          <p class="mt-1 truncate text-sm text-bark-800">{props.copy.job}</p>
        </div>
      </div>
      <dl class="mt-3 grid grid-cols-3 gap-2 text-center">
        <div class="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.commits}</dt>
          <dd class="font-pixel text-3xl leading-none">
            <CountUp to={JOB.commits} />
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.commits}</dd>
        </div>
        <div class="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.files}</dt>
          <dd class="font-pixel text-3xl leading-none">
            <CountUp to={JOB.files} />
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.files}</dd>
        </div>
        <div class="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.lines}</dt>
          <dd class="font-pixel text-xl sm:text-2xl leading-none sm:leading-none whitespace-nowrap">
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
      <div class="mt-3 flex items-center justify-between gap-3">
        <span class="flex items-center gap-1.5 text-sm text-leaf-700">
          <img src={props.icons.check} alt="" class="w-4 h-4 object-contain [image-rendering:pixelated]" />
          {props.copy.clean}
        </span>
        <span class="border-2 border-bark-900 bg-leaf-500 px-3 py-1.5 font-pixel text-base leading-none text-cream-50 [box-shadow:inset_2px_2px_0_var(--color-leaf-hover),_var(--shadow-hard-sm)]">
          {props.copy.take}
        </span>
      </div>
    </div>
  );
}
