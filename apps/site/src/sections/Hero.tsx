import type { JSX } from "@solidjs/web";
import { springValue, type MotionValue } from "motion";
import { createSignal, onCleanup } from "solid-js";

import { SCENES, firefliesOf, type Scene } from "../base/scene";
import type { Copy } from "../i18n/zh";
import { Icon } from "../ui/icons";
import { createElementRef, createScrollPosition, readMotion, reducedMotion, type ElementRef, observeVisibility, createScrollAnimation } from "../ui/scroll";
import { PaperLink } from "../ui/ui";

const hourVisibility = {
  morning: "opacity-[var(--scene-morning-opacity,0)]",
  day: "opacity-[var(--scene-day-opacity,0)]",
  evening: "opacity-[var(--scene-evening-opacity,0)]",
  night: "opacity-[var(--scene-night-opacity,0)]",
};
const hourButtonColors = {
  morning: "bg-[var(--scene-morning-button,_var(--color-cream-50))] hover:bg-cream-hover",
  day: "bg-[var(--scene-day-button,_var(--color-cream-50))] hover:bg-cream-hover",
  evening: "bg-[var(--scene-evening-button,_var(--color-cream-50))] hover:bg-cream-hover",
  night: "bg-[var(--scene-night-button,_var(--color-cream-50))] hover:bg-cream-hover",
};
/** The first screen of scrolling, while the scene holds on the screen (the hero is two screens high). */
const HOLDING: ["start start", "end end"] = ["start start", "end end"];
/** The second, while the scene goes up off the screen. */
const LEAVING: ["end end", "end start"] = ["end end", "end start"];
/** How far through the holding screen each later hour has faded in. */
const COMES: Record<Exclude<Scene, "morning">, [number, number]> = { day: [0.14, 0.3], evening: [0.42, 0.58], night: [0.7, 0.86] };
const TURNS: [number, Scene][] = [
  [0, "morning"],
  [0.22, "day"],
  [0.5, "evening"],
  [0.78, "night"],
];
/** Each later hour's line of the verse, through the holding screen: coming in, in, going, gone (the night's stays). */
const SAYS: Record<Exclude<Scene, "morning">, [number, number, number, number]> = {
  day: [0.24, 0.3, 0.44, 0.5],
  evening: [0.52, 0.58, 0.7, 0.76],
  night: [0.8, 0.86, 1, 1],
};
/** Where the hours' buttons take the page, as a share of the holding screen: each hour while its line is up. */
const POINTS: Record<Scene, number> = { morning: 0, day: 0.37, evening: 0.64, night: 1 };
const flies = { evening: firefliesOf("evening"), night: firefliesOf("night") };

const picturesOf = (root: ParentNode, scene: Scene) => [
  ...root.querySelectorAll<HTMLImageElement>(`[data-scene="${scene}"][data-src], [data-scene="${scene}"] [data-src]`),
];

interface Props {
  copy: Copy["hero"];
  backgrounds: Record<Scene, string>;
  github: string;
}

export default function Hero(props: Props) {
  const root = createElementRef<HTMLElement>();
  const [scene, setScene] = createSignal<Scene>("morning");
  let wanted: Scene = "morning";
  let disposed = false;
  // Pointer coordinates span -0.5 to 0.5 on each axis.
  const px = springValue<number>(0, { stiffness: 45, damping: 18 });
  const py = springValue<number>(0, { stiffness: 45, damping: 18 });
  onCleanup(() => {
    disposed = true;
    px.destroy();
    py.destroy();
  });
  const words = createScrollAnimation<HTMLDivElement>(root, HOLDING, () => [
    { keyframes: { transform: ["translateY(0px)", "translateY(0px)", "translateY(-56px)", "translateY(-56px)"] }, times: [0, 0.12, 0.22, 1] },
    { keyframes: { opacity: [1, 1, 0, 0] }, times: [0, 0.12, 0.22, 1] },
  ]);
  const hint = createScrollAnimation<HTMLAnchorElement>(root, HOLDING, () => [{ keyframes: { opacity: [1, 0, 0] }, times: [0, 0.08, 1] }]);
  let ahead = false;
  observeVisibility(root);
  /** How far through the holding screen the page is, 0 to 1. */
  const held = (y: number) => {
    const hero = root.get();
    const span = hero ? hero.offsetHeight - innerHeight : innerHeight;
    return Math.min(1, Math.max(0, y / Math.max(1, span)));
  };
  createScrollPosition((y) => {
    // Load later time-of-day renders as soon as the visitor begins scrolling.
    const element = root.get();
    if (!ahead && y > 0 && element) {
      ahead = true;
      for (const s of SCENES) for (const img of picturesOf(element, s)) if (!img.getAttribute("src")) img.src = img.dataset.src ?? "";
    }
    const q = held(y);
    const turn = TURNS.findLast(([from]) => q >= from);
    if (!turn) throw new RangeError(`No hero scene for scroll progress ${q}`);
    const hour = turn[1];
    if (hour !== wanted) void relight(hour);
  });
  function go(s: Scene) {
    const hero = root.get();
    if (!hero) return;
    window.scrollTo({ top: POINTS[s] * (hero.offsetHeight - innerHeight), behavior: reducedMotion() ? "auto" : "smooth" });
  }
  async function relight(next: Scene) {
    wanted = next;
    setScene(next);
    const element = root.get();
    const pictures = element ? picturesOf(element, next) : [];
    await Promise.all(
      pictures.map(async (img) => {
        if (!img.getAttribute("src")) img.src = img.dataset.src ?? "";
        try {
          await img.decode();
        } catch (error) {
          console.warn(`Failed to decode hero image ${img.currentSrc || img.src}`, error);
        }
      }),
    );
    if (wanted === next && !disposed) document.documentElement.dataset.scene = next;
  }
  function point(
    e: PointerEvent & {
      currentTarget: HTMLElement;
    },
  ) {
    if (reducedMotion() || e.pointerType !== "mouse") return;
    const box = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - box.left) / box.width - 0.5);
    py.set((e.clientY - box.top) / box.height - 0.5);
  }
  function leave() {
    px.set(0);
    py.set(0);
  }
  const stagger = Math.min(60, 360 / [...props.copy.name].length);
  const after = [...props.copy.name].length * stagger + 220;
  return (
    <section ref={root.set} id="top" aria-label={props.copy.name} class="relative h-[200svh] min-h-280">
      <div onPointerMove={point} onPointerLeave={leave} class="@container-[size] sticky top-0 isolate h-svh min-h-140 overflow-hidden bg-(--color-dusk)">
        {/* Full-bleed 16:9 Papertrails Metal diorama with gentle camera drift and time-of-day crossfade. */}
        <div aria-hidden="true" class="@container-[size] absolute top-1/2 left-1/2 aspect-[16/9] w-[max(106cqw,188cqh)] -translate-1/2">
          <Layer lag={0.42} zoom={1.06} origin="62% 56%" point={18} hero={root} px={px} py={py}>
            <div class="absolute inset-0 [transform-origin:58%_54%] [animation-name:title-pan] [animation-duration:64000ms] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite] [animation-direction:alternate]">
              <img
                data-scene="morning"
                data-src={props.backgrounds.morning}
                src={props.backgrounds.morning}
                alt=""
                draggable={false}
                class="absolute inset-0 w-full h-full max-w-none object-cover select-none"
              />
              <Comes hour="day" src={props.backgrounds.day} hero={root} />
              <Comes hour="evening" src={props.backgrounds.evening} hero={root} />
              <Comes hour="night" src={props.backgrounds.night} hero={root} />
              <noscript>
                <img src={props.backgrounds.morning} alt="" class="absolute inset-0 w-full h-full max-w-none object-cover" />
              </noscript>
              {(["evening", "night"] as const).map((at) => (
                <div class={["absolute inset-0 transition-[opacity] ease-out duration-900", hourVisibility[at]]}>
                  {flies[at].map((f, i) => (
                    <span
                      class="absolute rounded-full [animation-name:title-firefly,_title-blink] [animation-duration:6000ms,_2200ms] [animation-delay:0ms,_0ms] [animation-timing-function:ease-in-out,_ease-in-out] [animation-iteration-count:infinite,_infinite] [animation-direction:alternate,_alternate] [animation-fill-mode:none,_none] [animation-play-state:running,_running] bg-(--color-firefly) shadow-firefly"
                      style={{
                        left: `${f.x}%`,
                        top: `${f.y}%`,
                        width: `${f.size}px`,
                        height: `${f.size}px`,
                        "animation-duration": `${f.duration}s,${1.6 + (i % 5) * 0.4}s`,
                        "animation-delay": `${f.delay}s`,
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </Layer>
        </div>

        {/* Warm editorial walnut scrim keeps left-aligned typography crisp over the diorama. */}
        <div aria-hidden="true" class="pointer-events-none absolute inset-0 z-2 bg-[image:var(--scene-hero-shade)]" />
        <div
          ref={words.set}
          class="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end md:justify-center gap-4 px-[clamp(16px,6vw,96px)] pt-24 pb-24 md:pb-30 text-paper-core"
        >
          <div class="pointer-events-auto motion-safe:[animation-name:title-float] motion-safe:[animation-duration:5500ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite]">
            <h1 class="text-[length:clamp(44px,6.4vw,86px)] [text-shadow:var(--text-shadow-title)]">
              <span class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.name}</span>
              <span aria-hidden="true">
                {[...props.copy.name].map((ch, i) => (
                  <span
                    class="inline-block motion-safe:[animation-name:title-pop] motion-safe:[animation-duration:520ms] motion-safe:[animation-timing-function:var(--ease-out)] motion-safe:[animation-fill-mode:both]"
                    style={{
                      "animation-delay": `${i * stagger}ms`,
                    }}
                  >
                    {ch}
                  </span>
                ))}
              </span>
              <span class="mt-2.5 block font-sans text-xl font-semibold tracking-wider leading-none text-lantern [text-shadow:var(--text-shadow-ink)]">
                {props.copy.aka}
              </span>
            </h1>
          </div>
          <p
            class="pointer-events-auto font-display text-[length:clamp(26px,3.6vw,46px)] font-bold leading-[1.2] text-lantern [text-shadow:var(--text-shadow-ink)] motion-safe:[animation-name:title-in] motion-safe:[animation-duration:500ms] motion-safe:[animation-timing-function:var(--ease-out)] motion-safe:[animation-fill-mode:both]"
            style={{
              "animation-delay": `${after}ms`,
            }}
          >
            {props.copy.tagline}
          </p>
          <p
            class="pointer-events-auto font-display text-[length:clamp(19px,2.2vw,28px)] font-bold leading-[1.35] text-paper-core [text-shadow:var(--text-shadow-ink)] motion-safe:[animation-name:title-in] motion-safe:[animation-duration:500ms] motion-safe:[animation-timing-function:var(--ease-out)] motion-safe:[animation-fill-mode:both]"
            style={{
              "animation-delay": `${after + 90}ms`,
            }}
          >
            {props.copy.verses.morning.join("")}
          </p>
          <p
            class="pointer-events-auto max-w-[34em] text-base sm:text-lg text-cream-50/95 [text-shadow:var(--text-shadow-thin)] motion-safe:[animation-name:title-in] motion-safe:[animation-duration:500ms] motion-safe:[animation-timing-function:var(--ease-out)] motion-safe:[animation-fill-mode:both]"
            style={{
              "animation-delay": `${after + 180}ms`,
            }}
          >
            {props.copy.lead}
          </p>
          <div
            class="pointer-events-auto mt-2 flex flex-wrap gap-3.5 motion-safe:[animation-name:title-in] motion-safe:[animation-duration:500ms] motion-safe:[animation-timing-function:var(--ease-out)] motion-safe:[animation-fill-mode:both]"
            style={{
              "animation-delay": `${after + 270}ms`,
            }}
          >
            <PaperLink primary href={props.github}>
              {props.copy.primary}
            </PaperLink>
            <PaperLink href="#how">{props.copy.secondary}</PaperLink>
          </div>
        </div>

        {(["day", "evening", "night"] as const).map((h) => (
          <Line verse={props.copy.verses[h]} at={SAYS[h]} stays={h === "night"} hero={root} />
        ))}

        <div
          role="group"
          aria-label={props.copy.hours}
          class="absolute bottom-5 md:bottom-7 left-4 md:left-auto z-3 flex items-center gap-1.5 font-sans text-sm font-semibold leading-none text-paper-core [text-shadow:var(--text-shadow-ink)] md:right-[clamp(16px,4vw,40px)]"
        >
          <span class="mr-1 hidden md:inline">{props.copy.hours}</span>
          {SCENES.map((s) => (
            <button
              type="button"
              data-testid={`hero-hour-${s}`}
              aria-pressed={s === scene() ? "true" : "false"}
              onClick={() => go(s)}
              class={["cursor-pointer rounded-sm border border-bark-800/75 px-3 py-1.5 text-bark-900 shadow-card-sm", hourButtonColors[s]]}
            >
              {props.copy.hour[s]}
            </button>
          ))}
        </div>
        <a
          ref={hint.set}
          href="#parade"
          class="absolute bottom-5.5 left-1/2 z-3 hidden md:grid -translate-x-1/2 justify-items-center gap-1 font-sans text-xs font-medium tracking-wider leading-none text-paper-core [text-shadow:var(--text-shadow-ink)]"
        >
          {props.copy.scroll}
          <Icon
            name="arrow-down"
            class="w-4.5 h-4.5 motion-safe:[animation-name:hint-bob] motion-safe:[animation-duration:1500ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite]"
          />
        </a>
      </div>
    </section>
  );
}

/** Later scenes layer over the morning diorama render. */
function Comes(props: { hour: Exclude<Scene, "morning">; src: string; hero: ElementRef<HTMLElement> }) {
  const [from, to] = COMES[props.hour];
  const ref = createScrollAnimation<HTMLImageElement>(props.hero, HOLDING, () => [{ keyframes: { opacity: [0, 0, 1, 1] }, times: [0, from, to, 1] }], {
    still: true,
  });
  return (
    <img
      ref={ref.set}
      data-scene={props.hour}
      data-src={props.src}
      alt=""
      draggable={false}
      class="absolute inset-0 w-full h-full max-w-none object-cover opacity-0 select-none"
    />
  );
}

function Line(props: { verse: string[]; at: [number, number, number, number]; stays: boolean; hero: ElementRef<HTMLElement> }) {
  const [a, b, c, d] = props.at;
  const seen = createScrollAnimation<HTMLDivElement>(
    props.hero,
    HOLDING,
    () => [
      props.stays ? { keyframes: { opacity: [0, 0, 1, 1] }, times: [0, a, b, 1] } : { keyframes: { opacity: [0, 0, 1, 1, 0, 0] }, times: [0, a, b, c, d, 1] },
    ],
    { still: true },
  );
  const rise = createScrollAnimation<HTMLParagraphElement>(props.hero, HOLDING, () => [
    props.stays
      ? { keyframes: { transform: ["translateY(24px)", "translateY(24px)", "translateY(0px)", "translateY(0px)"] }, times: [0, a, b, 1] }
      : {
          keyframes: { transform: ["translateY(24px)", "translateY(24px)", "translateY(0px)", "translateY(0px)", "translateY(-24px)", "translateY(-24px)"] },
          times: [0, a, b, c, d, 1],
        },
  ]);
  return (
    <div
      ref={seen.set}
      class="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end md:justify-center px-[clamp(16px,6vw,96px)] pt-24 pb-28 md:pb-30 text-paper-core opacity-0"
    >
      <p ref={rise.set} class="font-display text-[length:clamp(32px,4.8vw,64px)] font-bold leading-[1.28] [text-shadow:var(--text-shadow-title)]">
        {props.verse.map((half) => (
          <span class="block">{half}</span>
        ))}
      </p>
    </div>
  );
}

function Layer(props: {
  lag: number;
  zoom: number;
  origin: string;
  point: number;
  hero: ElementRef<HTMLElement>;
  px: MotionValue<number>;
  py: MotionValue<number>;
  class?: JSX.ClassValue | undefined;
  children: JSX.Element;
}) {
  const away = createScrollAnimation<HTMLDivElement>(props.hero, LEAVING, () => [
    { keyframes: { transform: ["translateY(0px)", `translateY(${props.lag * innerHeight}px)`] } },
  ]);
  const closer = createScrollAnimation<HTMLDivElement>(props.hero, HOLDING, () => [{ keyframes: { transform: ["scale(1)", `scale(${props.zoom})`] } }]);
  const x = readMotion(props.px);
  const y = readMotion(props.py);
  return (
    <div ref={away.set} class={["absolute inset-0", props.class]}>
      <div
        ref={closer.set}
        class="absolute inset-0"
        style={{
          "transform-origin": props.origin,
        }}
      >
        <div
          class="absolute inset-0 will-change-transform"
          style={{
            transform: `translate(${reducedMotion() ? 0 : -x() * props.point}px, ${reducedMotion() ? 0 : -y() * props.point * 0.6}px)`,
          }}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
