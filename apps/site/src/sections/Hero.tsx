import type { JSX } from "@solidjs/web";
import { animate, springValue, type MotionValue } from "motion";
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";

import { CHIMNEY, CLOUDS, DOG, MANAGER, PET, PLANTS, PUFF_SECONDS, PUFFS, SCENES, SEEDS, firefliesOf, managerOf, pct, sprite, type Scene } from "../base/scene";
import type { Copy } from "../i18n/zh";
import { createElementRef, createScrollPosition, readMotion, reducedMotion, type ElementRef, observeVisibility, createScrollAnimation } from "../ui/scroll";
import { PixelLink } from "../ui/ui";

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
/** The plants in front of the camera that frame the village in the game (apps/web/src/farm/canvas): at the hero's corners, mostly past its edges. */
const framingStyles = {
  branchLeft: "-top-11 lg:-top-16.5 -left-15 lg:-left-22.5 w-51.5 lg:w-77.25",
  branchRight: "-top-12 lg:-top-18 -right-13 lg:-right-19.5 w-48.5 lg:w-72.75",
  bushLeft: "-bottom-18 lg:-bottom-27 -left-16 lg:-left-24 w-58 lg:w-87",
  bushRight: "-right-17 lg:-right-25.5 -bottom-16 lg:-bottom-24 w-59 lg:w-88.5",
};
const FRAME = ["branchLeft", "branchRight", "bushLeft", "bushRight"] as const;
export type Frame = Record<(typeof FRAME)[number], string>;
/** The first screen of scrolling, while the scene holds on the screen (the hero is two screens high). */
const HOLDING: ["start start", "end end"] = ["start start", "end end"];
/** The second, while the scene goes up off the screen. */
const LEAVING: ["end end", "end start"] = ["end end", "end start"];
/** How far through the holding screen each later hour has faded in: dawn's picture lies under the others, each later one comes in over the one before. */
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
const farmers = {
  morning: managerOf("morning"),
  day: managerOf("day"),
  evening: managerOf("evening"),
  night: managerOf("night"),
} satisfies Record<Scene, ReturnType<typeof managerOf>>;
const flies = { evening: firefliesOf("evening"), night: firefliesOf("night") };
const ROUND = [
  ["sit", 1400],
  ["tail", 500],
  ["sit", 500],
  ["tail", 500],
  ["sit", 2600],
  ["look", 2200],
  ["sit", 1800],
  ["tail", 600],
] as const;
/** The pictures of an hour still waiting for their src: its background and the farmer's pose. */
const picturesOf = (root: ParentNode, scene: Scene) => [
  ...root.querySelectorAll<HTMLImageElement>(`[data-scene="${scene}"][data-src], [data-scene="${scene}"] [data-src]`),
];
interface Props {
  copy: Copy["hero"];
  /** The title scene's sprites, and each hour's picture (images.ts). */
  art: Readonly<Record<string, string>>;
  backgrounds: Record<Scene, string>;
  /** The arrow under "scroll down". */
  hint: string;
  frame: Frame;
  github: string;
}
export default function Hero(props: Props) {
  const root = createElementRef<HTMLElement>();
  const [scene, setScene] = createSignal<Scene>("morning");
  let wanted: Scene = "morning";
  let disposed = false;
  // Pointer coordinates span -0.5 to 0.5 on each axis.
  const px = springValue<number>(0, { stiffness: 50, damping: 18 });
  const py = springValue<number>(0, { stiffness: 50, damping: 18 });
  onCleanup(() => {
    disposed = true;
    px.destroy();
    py.destroy();
  });
  const words = createScrollAnimation<HTMLDivElement>(root, HOLDING, () => [
    { keyframes: { transform: ["translateY(0px)", "translateY(0px)", "translateY(-60px)", "translateY(-60px)"] }, times: [0, 0.12, 0.22, 1] },
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
    // The later hours' pictures load as soon as the page moves, so each is there when its turn comes.
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
  const stagger = Math.min(70, 420 / [...props.copy.name].length);
  const after = [...props.copy.name].length * stagger + 260;
  return (
    <>
      {/* Two screens high: the scene holds on the first screen of scrolling, and goes up off the screen on the second. */}
      <section ref={root.set} id="top" aria-label={props.copy.name} class="relative h-[200svh] min-h-280">
        <div onPointerMove={point} onPointerLeave={leave} class="@container-[size] sticky top-0 isolate h-svh min-h-140 overflow-hidden bg-(--color-dusk)">
          {/* The scene keeps its 3:2 and covers the hero, a little bigger, so the layers have room to part. */}
          <div aria-hidden="true" class="@container-[size] absolute top-1/2 left-1/2 aspect-[3/2] w-[max(108cqw,162cqh)] -translate-1/2">
            <Layer lag={0.5} zoom={1.06} origin="62% 60%" point={16} hero={root} px={px} py={py}>
              <div class="absolute inset-0 [transform-origin:60%_55%] [animation-name:title-pan] [animation-duration:70000ms] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite] [animation-direction:alternate]">
                <img
                  data-scene="morning"
                  data-src={props.backgrounds.morning}
                  src={props.backgrounds.morning}
                  alt=""
                  draggable={false}
                  class="absolute inset-0 w-full h-full max-w-none select-none [image-rendering:pixelated]"
                />
                <Comes hour="day" src={props.backgrounds.day} hero={root} />
                <Comes hour="evening" src={props.backgrounds.evening} hero={root} />
                <Comes hour="night" src={props.backgrounds.night} hero={root} />
                <noscript>
                  <img src={props.backgrounds.morning} alt="" class="absolute inset-0 w-full h-full max-w-none [image-rendering:pixelated]" />
                </noscript>
                {PUFFS.map((p, i) => {
                  const s = sprite(p.sprite, p.scale);
                  return (
                    <img
                      src={props.art[s.name]}
                      alt=""
                      draggable={false}
                      fetchpriority="low"
                      class="absolute top-(--y0) left-(--x0) max-w-none [transform-origin:bottom] [translate:-50%_-100%] [animation-name:title-puff] [animation-duration:8000ms] [animation-timing-function:linear] [animation-iteration-count:infinite] opacity-0 [filter:var(--smoke)] [transition:filter_.9s] select-none [image-rendering:pixelated]"
                      style={{
                        "--x0": pct(CHIMNEY.x),
                        "--y0": pct(CHIMNEY.y),
                        width: pct(s.w),
                        "animation-duration": `${PUFF_SECONDS}s`,
                        "animation-delay": `${-(i * PUFF_SECONDS) / PUFFS.length}s`,
                      }}
                    />
                  );
                })}
                {(["evening", "night"] as const).map((at) => (
                  <div class={["absolute inset-0 transition-[opacity] ease-out duration-900", hourVisibility[at]]}>
                    {flies[at].map((f, i) => (
                      <span
                        class="absolute [animation-name:title-firefly,_title-blink] [animation-duration:6000ms,_2000ms] [animation-delay:0ms,_0ms] [animation-timing-function:ease-in-out,_ease-in-out] [animation-iteration-count:infinite,_infinite] [animation-direction:alternate,_alternate] [animation-fill-mode:none,_none] [animation-play-state:running,_running] bg-(--color-firefly) shadow-firefly"
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
              {SCENES.map((s) => (
                <div
                  data-scene={s}
                  class={[
                    "absolute [transform-origin:bottom] [animation-name:title-breathe] [animation-duration:3200ms] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite] transition-[opacity] ease-out duration-900",
                    hourVisibility[s],
                  ]}
                  style={{
                    left: pct(MANAGER.x - farmers[s].w / 2),
                    top: pct(MANAGER.bottom - farmers[s].h),
                    width: pct(farmers[s].w),
                    height: pct(farmers[s].h),
                  }}
                >
                  <img
                    src={s === "morning" ? props.art[farmers[s].name] : undefined}
                    data-src={props.art[farmers[s].name]}
                    alt=""
                    draggable={false}
                    class="block w-full h-full max-w-none [filter:var(--farmer)] [transition:filter_.9s] select-none [image-rendering:pixelated]"
                  />
                  {s === "night" && (
                    <span class="absolute top-[70%] left-[4%] aspect-square w-[34%] -translate-1/2 [animation-name:title-lantern] [animation-duration:2400ms] [animation-timing-function:steps(6)] [animation-iteration-count:infinite] [animation-direction:alternate] rounded-full bg-[image:var(--scene-lantern-background)] mix-blend-screen" />
                  )}
                </div>
              ))}
              <Dog scene={scene()} art={props.art} />
            </Layer>
            <Layer lag={0.62} zoom={1.03} origin="50% 30%" point={8} hero={root} px={px} py={py}>
              {CLOUDS.map((c) => {
                const s = sprite(c.sprite, c.scale);
                return (
                  <img
                    src={props.art[s.name]}
                    alt=""
                    draggable={false}
                    fetchpriority="low"
                    class="absolute left-0 max-w-none [animation-name:title-cloud] [animation-duration:160000ms] [animation-timing-function:linear] [animation-iteration-count:infinite] [filter:var(--sky)] [transition:filter_.9s] select-none [image-rendering:pixelated]"
                    style={{
                      top: pct(c.y),
                      width: pct(s.w),
                      "animation-duration": `${c.duration}s`,
                      "animation-delay": `${c.delay}s`,
                    }}
                  />
                );
              })}
            </Layer>
            <Layer lag={0.28} zoom={1.12} origin="50% 100%" point={36} hero={root} px={px} py={py}>
              <div class="absolute inset-0 transition-[opacity] ease-out duration-900 opacity-[var(--scene-seed-opacity,1)]">
                {SEEDS.map((seed) => {
                  const s = sprite(seed.sprite, 0.22);
                  return (
                    <span
                      class="absolute top-[86%] left-(--x0) [animation-name:title-seed-x,_title-seed-y] [animation-duration:18000ms,_18000ms] [animation-delay:0ms,_0ms] [animation-timing-function:ease-in-out,_ease-in-out] [animation-iteration-count:infinite,_infinite] [animation-direction:normal,_normal] [animation-fill-mode:none,_none] [animation-play-state:running,_running] opacity-0"
                      style={{
                        "--x0": pct(seed.from),
                        width: pct(s.w),
                        "animation-duration": `${seed.duration}s`,
                        "animation-delay": `${seed.delay}s`,
                      }}
                    >
                      <img
                        src={props.art[s.name]}
                        alt=""
                        draggable={false}
                        fetchpriority="low"
                        class="block w-full max-w-none [animation-name:title-seed-spin] [animation-duration:3000ms] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite] [animation-direction:alternate] [filter:var(--ground)] [transition:filter_.9s] [image-rendering:pixelated]"
                        style={{
                          "animation-delay": `${seed.delay}s`,
                        }}
                      />
                    </span>
                  );
                })}
              </div>
              {PLANTS.map((p, i) => {
                const s = sprite(p.sprite, p.scale);
                return (
                  <img
                    src={props.art[s.name]}
                    alt=""
                    draggable={false}
                    fetchpriority="low"
                    class="absolute bottom-0 max-w-none [transform-origin:bottom] [animation-name:title-sway] [animation-duration:4000ms] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite] [animation-direction:alternate] [filter:var(--ground)] [transition:filter_.9s] select-none [image-rendering:pixelated]"
                    style={{
                      "--lean": `${p.lean}deg`,
                      left: pct(p.x - s.w / 2),
                      width: pct(s.w),
                      "animation-duration": `${p.sway}s`,
                      "animation-delay": `${-i * 0.7}s`,
                    }}
                  />
                );
              })}
            </Layer>
          </div>
          {/* In front of the camera, ahead of the page: the frame's plants, pushed out past the corners as the camera goes in. */}
          <Layer lag={-0.08} zoom={1.3} origin="50% 50%" point={64} hero={root} px={px} py={py} class="pointer-events-none">
            {FRAME.map((f) => (
              <img
                src={props.frame[f]}
                alt=""
                aria-hidden="true"
                draggable={false}
                class={[
                  "[filter:var(--ground)] transition-[filter] duration-900 ease-[ease] [image-rendering:pixelated] absolute max-w-none select-none",
                  framingStyles[f],
                ]}
              />
            ))}
          </Layer>

          {/* The shade stays while the words change. */}
          <div aria-hidden="true" class="pointer-events-none absolute inset-0 z-2 bg-[image:var(--scene-hero-shade)]" />
          <div
            ref={words.set}
            class="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end md:justify-center gap-4.5 px-[clamp(16px,6vw,96px)] pt-24 pb-24 md:pb-30 text-cream-50"
          >
            <div
              class={[
                "motion-safe:[animation-name:title-float] motion-safe:[animation-duration:5000ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:none] motion-safe:[animation-play-state:running]",
                "pointer-events-auto",
              ]}
            >
              <h1 class="text-[length:clamp(48px,7vw,96px)] [text-shadow:var(--text-shadow-title)]">
                <span class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{props.copy.name}</span>
                <span aria-hidden="true">
                  {[...props.copy.name].map((ch, i) => (
                    <span
                      class="inline-block motion-safe:[animation-name:title-pop] motion-safe:[animation-duration:500ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:steps(5)] motion-safe:[animation-iteration-count:1] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:both] motion-safe:[animation-play-state:running]"
                      style={{
                        "animation-delay": `${i * stagger}ms`,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
                <span class="mt-2.5 block text-2xl leading-none text-wheat [text-shadow:2px_2px_0_var(--color-bark-900)]">{props.copy.aka}</span>
              </h1>
            </div>
            <p
              class={[
                "font-pixel text-[length:clamp(30px,4.2vw,54px)] leading-[1.15] text-wheat [text-shadow:2px_2px_0_var(--color-bark-900)] motion-safe:[animation-name:title-in] motion-safe:[animation-duration:450ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:steps(5)] motion-safe:[animation-iteration-count:1] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:both] motion-safe:[animation-play-state:running]",
                "pointer-events-auto",
              ]}
              style={{
                "animation-delay": `${after}ms`,
              }}
            >
              {props.copy.tagline}
            </p>
            <p
              class={[
                "font-pixel text-[length:clamp(20px,2.4vw,30px)] leading-[1.3] [text-shadow:2px_2px_0_var(--color-bark-900)] motion-safe:[animation-name:title-in] motion-safe:[animation-duration:450ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:steps(5)] motion-safe:[animation-iteration-count:1] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:both] motion-safe:[animation-play-state:running]",
                "pointer-events-auto",
              ]}
              style={{
                "animation-delay": `${after + 90}ms`,
              }}
            >
              {props.copy.verses.morning.join("")}
            </p>
            <p
              class="max-w-[34em] text-base sm:text-lg [text-shadow:var(--text-shadow-thin)] motion-safe:[animation-name:title-in] motion-safe:[animation-duration:450ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:steps(5)] motion-safe:[animation-iteration-count:1] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:both] motion-safe:[animation-play-state:running] pointer-events-auto"
              style={{
                "animation-delay": `${after + 180}ms`,
              }}
            >
              {props.copy.lead}
            </p>
            <div
              class={[
                "mt-2 flex flex-wrap gap-3.5 motion-safe:[animation-name:title-in] motion-safe:[animation-duration:450ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:steps(5)] motion-safe:[animation-iteration-count:1] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:both] motion-safe:[animation-play-state:running]",
                "pointer-events-auto",
              ]}
              style={{
                "animation-delay": `${after + 270}ms`,
              }}
            >
              <PixelLink primary href={props.github}>
                {props.copy.primary}
              </PixelLink>
              <PixelLink href="#how">{props.copy.secondary}</PixelLink>
            </div>
          </div>

          {(["day", "evening", "night"] as const).map((h) => (
            <Line verse={props.copy.verses[h]} at={SAYS[h]} stays={h === "night"} hero={root} />
          ))}

          <div
            role="group"
            aria-label={props.copy.hours}
            class="absolute bottom-5 md:bottom-7 left-4 md:left-auto z-3 flex items-center gap-1.5 font-pixel text-lg leading-none text-cream-50 [text-shadow:2px_2px_0_var(--color-bark-900)] md:right-[clamp(16px,4vw,40px)]"
          >
            <span class="hidden md:inline">{props.copy.hours}</span>
            {SCENES.map((s) => (
              <button
                type="button"
                data-testid={`hero-hour-${s}`}
                aria-pressed={s === scene() ? "true" : "false"}
                onClick={() => go(s)}
                class={["cursor-pointer border-2 border-bark-900 px-2.5 py-1.5 text-bark-900 [box-shadow:2px_2px_0_var(--color-drop)]", hourButtonColors[s]]}
              >
                {props.copy.hour[s]}
              </button>
            ))}
          </div>
          <a
            ref={hint.set}
            href="#parade"
            class="absolute bottom-5.5 left-1/2 z-3 hidden md:grid -translate-x-1/2 justify-items-center gap-1 font-pixel text-lg leading-none text-cream-50 [text-shadow:2px_2px_0_var(--color-bark-900)]"
          >
            {props.copy.scroll}
            <img
              src={props.hint}
              alt=""
              class="w-5 [rotate:90deg] [image-rendering:pixelated] motion-safe:[animation-name:hint-bob] motion-safe:[animation-duration:1200ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:steps(2)] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:none] motion-safe:[animation-play-state:running]"
            />
          </a>
        </div>
      </section>
    </>
  );
}
/** Later scenes layer over the morning artwork. */
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
      class="absolute inset-0 w-full h-full max-w-none opacity-0 select-none [image-rendering:pixelated]"
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
      ? { keyframes: { transform: ["translateY(28px)", "translateY(28px)", "translateY(0px)", "translateY(0px)"] }, times: [0, a, b, 1] }
      : {
          keyframes: { transform: ["translateY(28px)", "translateY(28px)", "translateY(0px)", "translateY(0px)", "translateY(-28px)", "translateY(-28px)"] },
          times: [0, a, b, c, d, 1],
        },
  ]);
  return (
    <div
      ref={seen.set}
      class="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end md:justify-center px-[clamp(16px,6vw,96px)] pt-24 pb-28 md:pb-30 text-cream-50 opacity-0"
    >
      <p ref={rise.set} class="font-pixel text-[length:clamp(34px,5.2vw,72px)] leading-[1.25] [text-shadow:var(--text-shadow-title)]">
        {props.verse.map((half) => (
          <span class="block">{half}</span>
        ))}
      </p>
    </div>
  );
}
/** Nearer layers use larger zoom factors around their own origins. */
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
function Dog(props: { scene: Scene; art: Readonly<Record<string, string>> }) {
  const [frame, setFrame] = createSignal<keyof typeof DOG>("sit");
  const [noticed, setNoticed] = createSignal(false);
  const image = createElementRef<HTMLImageElement>();
  createEffect(
    () => [props.scene, noticed()] as const,
    ([hour, active]) => {
      if (active) {
        setFrame("look");
        return;
      }
      if (hour === "night") {
        setFrame("sleep");
        return;
      }
      if (reducedMotion()) {
        setFrame("sit");
        return;
      }
      let at = 0;
      let timer = 0;
      const step = () => {
        const frame = ROUND[at++ % ROUND.length];
        if (!frame) throw new RangeError(`Invalid dog animation frame ${at - 1}`);
        const [name, ms] = frame;
        setFrame(name);
        timer = window.setTimeout(step, ms);
      };
      step();
      return () => window.clearTimeout(timer);
    },
  );
  onSettled(() => {
    createEffect(noticed, (active) => {
      const element = image.get();
      if (!element || reducedMotion()) return;
      const animation = animate(element, { y: active ? [0, -14, 0, -7, 0] : 0 }, { duration: 0.55, ease: "easeOut" });
      return () => animation.stop();
    });
  });
  const f = createMemo(() => DOG[frame()]);
  return (
    <img
      ref={image.set}
      src={props.art[f().name]}
      alt=""
      draggable={false}
      onPointerEnter={() => setNoticed(true)}
      onPointerLeave={() => setNoticed(false)}
      class="absolute max-w-none -translate-x-1/2 [filter:var(--ground)] [transition:filter_.9s] select-none [image-rendering:pixelated]"
      style={{
        left: pct(PET.x),
        bottom: pct(1 - PET.bottom),
        width: pct(f().w),
      }}
    />
  );
}
