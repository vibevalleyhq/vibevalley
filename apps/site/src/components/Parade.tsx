import { observeVisibility, createReveal, createScrollAnimation } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
/** While the section crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING = ["start end", "end start"] as ["start end", "end start"];
interface Props {
  copy: Copy["parade"];
  /** The plots behind, left to right. */
  plots: string[];
  /** Each helper's side frames in a step: step, stand, step, stand. */
  walkers: string[][];
  /** The plants in front. */
  front: string[];
}
export default function Parade(props: Props) {
  const ref = createReveal<HTMLElement>();
  // The plots slide left by 120 px as the section crosses the screen, the plants in front right by 300.
  const back = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(60px)", "translateX(-60px)"] } }]);
  const near = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(-150px)", "translateX(150px)"] } }]);
  observeVisibility(ref);
  return (
    <>
      <section
        ref={ref.set}
        id="parade"
        aria-labelledby="parade-title"
        class="[container-type:inline-size] relative h-[400px] overflow-hidden border-y-2 border-bark-900 bg-[linear-gradient(180deg,#9fc6d9_0%,#cfe3d6_49%,#7fa84e_49%,#6b9241_100%)]"
      >
        <div ref={back.set} aria-hidden="true" class="absolute bottom-[108px] left-[-10%] flex w-[120%] items-end gap-6">
          {props.plots.map((src) => (
            <img loading="lazy" src={src} alt="" class="pixelated w-[102px] max-w-none" />
          ))}
        </div>
        <div
          aria-hidden="true"
          class="border-path-edge absolute bottom-[38px] h-16 w-full border-y-2 bg-[repeating-linear-gradient(90deg,var(--color-path)_0_22px,var(--color-path-groove)_22px_26px)]"
        />
        {props.walkers.map((frames, i) => (
          <div
            aria-hidden="true"
            class="animate-walk absolute bottom-[54px] left-0 h-[84px] w-12"
            style={{
              "animation-duration": `${26 + (i % 3) * 7}s`,
              "animation-delay": `${-i * 5.3}s`,
            }}
          >
            {frames.map((src, j) => (
              <img
                src={src}
                alt=""
                loading="lazy"
                class="animate-walk-frame pixelated absolute inset-0 size-full object-contain object-bottom opacity-0"
                style={{
                  "animation-delay": `${j * 0.15}s`,
                }}
              />
            ))}
          </div>
        ))}
        <div ref={near.set} aria-hidden="true" class="absolute bottom-[-18px] left-[-10%] flex w-[120%] items-end gap-[120px]">
          {props.front.map((src) => (
            <img loading="lazy" src={src} alt="" class="pixelated w-[150px] max-w-none" />
          ))}
        </div>
        <div data-reveal class="panel absolute inset-x-0 top-[22px] z-2 mx-auto w-[min(760px,calc(100%-32px))] px-[22px] py-3.5 text-center">
          <h2 id="parade-title" class="text-2xl sm:text-[30px]">
            {props.copy.title}
          </h2>
          <p class="mt-1.5 text-sm sm:text-base">{props.copy.text}</p>
        </div>
      </section>
    </>
  );
}
