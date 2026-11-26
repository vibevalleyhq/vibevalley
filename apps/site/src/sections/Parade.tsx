/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { observeVisibility, createReveal, createScrollAnimation } from "../ui/scroll";

/** While the section crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING: ["start end", "end start"] = ["start end", "end start"];

interface Walker {
  readonly look: string;
  readonly portrait: string;
  readonly figurine?: string;
}

interface Props {
  copy: Copy["parade"];
  /** Isometric Papertrails crop & garden tiles behind the path. */
  plots: string[];
  /** Seven species helpers in Papertrails cardstock medallions & figurines. */
  walkers: readonly Walker[];
  /** Foreground Papertrails bamboo and willow cutouts. */
  front: string[];
}

export default function Parade(props: Props) {
  const ref = createReveal<HTMLElement>();
  const back = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(60px)", "translateX(-60px)"] } }]);
  const near = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(-120px)", "translateX(120px)"] } }]);
  observeVisibility(ref);
  return (
    <section
      ref={ref.set}
      id="parade"
      aria-labelledby="parade-title"
      class="@container relative h-104 overflow-hidden border-y border-border-soft/35 bg-[image:var(--scene-parade-background)]"
    >
      <div ref={back.set} aria-hidden="true" class="absolute bottom-26 -left-[10%] flex w-[120%] items-end gap-5">
        {props.plots.map((src) => (
          <img loading="lazy" src={src} alt="" class="w-28 max-w-none drop-shadow-[0_4px_6px_rgb(91_67_43_/_0.2)]" />
        ))}
      </div>
      <div
        aria-hidden="true"
        class="absolute bottom-10 h-16 w-full border-y border-(--color-path-edge)/50 bg-[image:repeating-linear-gradient(90deg,var(--color-path)_0_28px,var(--color-path-groove)_28px_30px)]"
      />
      {props.walkers.map((walker, i) => (
        <div
          aria-hidden="true"
          class="absolute bottom-14 left-0 [animation-name:walk-across] [animation-duration:30000ms] [animation-timing-function:linear] [animation-iteration-count:infinite]"
          style={{
            "animation-duration": `${26 + (i % 3) * 7}s`,
            "animation-delay": `${-i * 5.2}s`,
          }}
        >
          <div
            class="motion-safe:[animation-name:paper-bob] motion-safe:[animation-duration:1800ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite]"
            style={{
              "animation-delay": `${-i * 0.35}s`,
            }}
          >
            {walker.figurine !== undefined ? (
              <img loading="lazy" src={walker.figurine} alt="" class="h-22 w-auto max-w-none drop-shadow-[0_6px_8px_rgb(91_67_43_/_0.28)]" />
            ) : (
              <div class="rounded-md border-2 border-paper-core bg-card p-1 shadow-card">
                <img loading="lazy" src={walker.portrait} alt="" class="h-14 w-14 rounded-sm object-cover" />
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={near.set} aria-hidden="true" class="pointer-events-none absolute -bottom-3 -left-[10%] flex w-[120%] items-end gap-32">
        {props.front.map((src) => (
          <img loading="lazy" src={src} alt="" class="h-28 w-auto max-w-none drop-shadow-[0_4px_8px_rgb(91_67_43_/_0.22)]" />
        ))}
      </div>
      <div
        data-reveal
        class="absolute inset-x-0 top-5.5 z-2 mx-auto w-[min(760px,100%_-_32px)] rounded-lg border border-border-soft/45 bg-card/95 [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] backdrop-blur-xs px-6 py-4 text-center"
      >
        <h2 id="parade-title" class="text-2xl sm:text-[length:28px] text-bark-900">
          {props.copy.title}
        </h2>
        <p class="mt-1.5 text-sm sm:text-base text-bark-800">{props.copy.text}</p>
      </div>
    </section>
  );
}
