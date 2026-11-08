import { observeVisibility, createReveal, createScrollAnimation } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { JOB } from "../lib/story";
import { CountUp } from "./ui";
/** While the band crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING = ["start end", "end start"] as ["start end", "end start"];
interface Props {
  copy: Copy["harvest"];
  /** The ripe plots, the row behind and the row in front. */
  rows: [string[], string[]];
  coins: string;
  /** The harvest list's icon and its check. */
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
      class="relative overflow-hidden border-y-2 border-bark-900 bg-[linear-gradient(180deg,#f6dc94_0%,#eab654_55%,#c98d32_100%)] px-4 py-[clamp(96px,13vw,170px)]"
    >
      <div ref={back.set} aria-hidden="true" class="absolute top-[6%] left-[-10%] flex w-[120%] items-end gap-5 opacity-60">
        {props.rows[0].map((src) => (
          <img loading="lazy" src={src} alt="" class="pixelated w-[68px] max-w-none sm:w-[102px]" />
        ))}
      </div>
      <div ref={front.set} aria-hidden="true" class="absolute bottom-[-4%] left-[-10%] flex w-[120%] items-end gap-6">
        {props.rows[1].map((src) => (
          <img loading="lazy" src={src} alt="" class="pixelated w-[102px] max-w-none sm:w-[136px]" />
        ))}
      </div>
      {/* A shade behind the words, so they read over the field. */}
      <div aria-hidden="true" class="absolute inset-0 bg-[radial-gradient(ellipse_60%_55%_at_50%_50%,rgb(30_20_10/0.55),transparent_75%)]" />
      <div class="relative mx-auto max-w-[920px] text-center text-cream-50">
        <div aria-hidden="true" class="mb-4 flex justify-center gap-3">
          {[0, 1, 2].map((i) => (
            <img
              loading="lazy"
              src={props.coins}
              alt=""
              class="pixelated motion-safe:animate-float w-9 sm:w-11"
              style={{
                "animation-delay": `${i * -1.6}s`,
              }}
            />
          ))}
        </div>
        <h2 id="harvest-title" data-reveal class="text-shadow-title text-[clamp(40px,8vw,104px)]/[1.2]">
          {props.copy.title.map((line) => (
            <span class="block">{line}</span>
          ))}
        </h2>
        <p data-reveal={120} class="text-shadow-thin mx-auto mt-5 max-w-[34em] text-lg text-balance sm:text-xl">
          {props.copy.text}
        </p>
        <HarvestList copy={props.copy.card} icons={props.icons} />
      </div>
    </section>
  );
}
/** The story's job as the app's harvest list shows it. */
function HarvestList(props: {
  copy: Copy["harvest"]["card"];
  icons: {
    harvest: string;
    check: string;
  };
}) {
  return (
    <div data-reveal={240} class="panel mx-auto mt-9 w-[min(480px,100%)] p-4 text-left text-bark-900">
      <div class="flex items-center gap-2.5">
        <img src={props.icons.harvest} alt="" class="pixelated size-8 object-contain" />
        <div class="min-w-0">
          <p class="font-pixel text-lg/none">{props.copy.title}</p>
          <p class="mt-1 truncate text-sm text-bark-800">{props.copy.job}</p>
        </div>
      </div>
      <dl class="mt-3 grid grid-cols-3 gap-2 text-center">
        <div class="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt class="sr-only">{props.copy.commits}</dt>
          <dd class="font-pixel text-3xl/none">
            <CountUp to={JOB.commits} />
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.commits}</dd>
        </div>
        <div class="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt class="sr-only">{props.copy.files}</dt>
          <dd class="font-pixel text-3xl/none">
            <CountUp to={JOB.files} />
          </dd>
          <dd class="mt-1 text-xs text-bark-800">{props.copy.files}</dd>
        </div>
        <div class="border-2 border-bark-900 bg-cream-100 px-2 py-2">
          <dt class="sr-only">{props.copy.lines}</dt>
          <dd class="font-pixel text-xl/none whitespace-nowrap sm:text-2xl/none">
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
          <img src={props.icons.check} alt="" class="pixelated size-4 object-contain" />
          {props.copy.clean}
        </span>
        <span class="inset-shadow-lit shadow-hard-sm border-2 border-bark-900 bg-leaf-500 px-3 py-1.5 font-pixel text-base/none text-cream-50 inset-shadow-leaf-hover">
          {props.copy.take}
        </span>
      </div>
    </div>
  );
}
