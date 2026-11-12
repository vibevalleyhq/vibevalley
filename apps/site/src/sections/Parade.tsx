/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { observeVisibility, createReveal, createScrollAnimation } from "../ui/scroll";

/** While the section crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING: ["start end", "end start"] = ["start end", "end start"];
interface Props {
  copy: Copy["parade"];
  /** The plots behind, left to right. */
  plots: string[];
  /** Each helper's side frames in a step: step, stand, step, stand. */
  walkers: string[][];
  front: string[];
}
export default function Parade(props: Props) {
  const ref = createReveal<HTMLElement>();
  const back = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(60px)", "translateX(-60px)"] } }]);
  const near = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(-150px)", "translateX(150px)"] } }]);
  observeVisibility(ref);
  return (
    <>
      <section
        ref={ref.set}
        id="parade"
        aria-labelledby="parade-title"
        class="@container relative h-100 overflow-hidden border-y-2 border-bark-900 bg-[image:var(--scene-parade-background)]"
      >
        <div ref={back.set} aria-hidden="true" class="absolute bottom-27 -left-[10%] flex w-[120%] items-end gap-6">
          {props.plots.map((src) => (
            <img loading="lazy" src={src} alt="" class="w-25.5 max-w-none [image-rendering:pixelated]" />
          ))}
        </div>
        <div
          aria-hidden="true"
          class="absolute bottom-9.5 h-16 w-full border-y-2 border-(--color-path-edge) bg-[image:repeating-linear-gradient(90deg,var(--color-path)_0_22px,var(--color-path-groove)_22px_26px)]"
        />
        {props.walkers.map((frames, i) => (
          <div
            aria-hidden="true"
            class="absolute bottom-13.5 left-0 h-21 w-12 [animation-name:walk-across] [animation-duration:30000ms] [animation-timing-function:linear] [animation-iteration-count:infinite]"
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
                class="absolute inset-0 w-full h-full [animation-name:walk-frame] [animation-duration:600ms] [animation-timing-function:steps(1)] [animation-iteration-count:infinite] object-contain object-bottom opacity-0 [image-rendering:pixelated]"
                style={{
                  "animation-delay": `${j * 0.15}s`,
                }}
              />
            ))}
          </div>
        ))}
        <div ref={near.set} aria-hidden="true" class="absolute -bottom-4.5 -left-[10%] flex w-[120%] items-end gap-30">
          {props.front.map((src) => (
            <img loading="lazy" src={src} alt="" class="w-37.5 max-w-none [image-rendering:pixelated]" />
          ))}
        </div>
        <div
          data-reveal
          class="absolute inset-x-0 top-5.5 z-2 mx-auto w-[min(760px,100%_-_32px)] border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] px-5.5 py-3.5 text-center"
        >
          <h2 id="parade-title" class="text-2xl sm:text-[length:30px]">
            {props.copy.title}
          </h2>
          <p class="mt-1.5 text-sm sm:text-base">{props.copy.text}</p>
        </div>
      </section>
    </>
  );
}
