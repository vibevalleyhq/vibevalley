import type { JSX } from "@solidjs/web";
/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
import { animate, springValue, type MotionValue } from "motion";
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";

import {
  createElementRef,
  createScrollPosition,
  readMotion,
  reducedMotion,
  type ElementRef,
  observeVisibility,
  createScrollAnimation,
} from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { CHIMNEY, CLOUDS, DOG, MANAGER, PET, PLANTS, PUFF_SECONDS, PUFFS, SCENES, SEEDS, firefliesOf, managerOf, pct, sprite, type Scene } from "../lib/scene";
import { PixelLink, cx, domAttrs, vars } from "./ui";

const viewStyles = stylex.create({
  layer: { position: "absolute", inset: 0 },
  framingLayer: { pointerEvents: "none" },
  framingImage: {
    filter: "var(--ground)",
    transitionProperty: "filter",
    transitionDuration: "0.9s",
    transitionTimingFunction: "ease",
    imageRendering: "pixelated",
    position: "absolute",
    maxWidth: "none",
    userSelect: "none",
  },
  heroSection: {
    position: "relative",
    height: "200svh",
    minHeight: "1120px",
  },
  heroDiv: {
    containerType: "size",
    position: "sticky",
    top: "0",
    isolation: "isolate",
    height: "100svh",
    minHeight: "560px",
    overflow: "hidden",
    backgroundColor: "var(--color-dusk)",
  },
  heroDiv2: {
    containerType: "size",
    position: "absolute",
    top: "50%",
    left: "50%",
    aspectRatio: "3/2",
    width: "max(108cqw,162cqh)",
    translate: "calc(calc(1 / 2 * 100%) * -1) calc(calc(1 / 2 * 100%) * -1)",
  },
  heroImg: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  heroSpan: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },
  heroSpan2: {
    marginTop: "calc(var(--spacing) * 2.5)",
    display: "block",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
    color: "var(--color-wheat)",
    textShadow: "2px 2px 0 var(--color-bark-900)",
  },
  heroDiv3: {
    position: "absolute",
    bottom: {
      default: "calc(var(--spacing) * 5)",
      "@media (width>=48rem)": "calc(var(--spacing) * 7)",
    },
    left: {
      default: "calc(var(--spacing) * 4)",
      "@media (width>=48rem)": "auto",
    },
    zIndex: "3",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
    textShadow: "2px 2px 0 var(--color-bark-900)",
    right: {
      default: null,
      "@media (width>=48rem)": "clamp(16px,4vw,40px)",
    },
  },
  heroSpan3: {
    display: {
      default: "none",
      "@media (width>=48rem)": "inline",
    },
  },
  heroA: {
    position: "absolute",
    bottom: "22px",
    left: "50%",
    zIndex: "3",
    display: {
      default: "none",
      "@media (width>=48rem)": "grid",
    },
    translate: "calc(calc(1 / 2 * 100%) * -1) 0",
    justifyItems: "center",
    gap: "var(--spacing)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
    textShadow: "2px 2px 0 var(--color-bark-900)",
  },
  lineDiv: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
    zIndex: "2",
    display: "flex",
    flexDirection: "column",
    justifyContent: {
      default: "flex-end",
      "@media (width>=48rem)": "center",
    },
    paddingInline: "clamp(16px,6vw,96px)",
    paddingTop: "calc(var(--spacing) * 24)",
    paddingBottom: {
      default: "calc(var(--spacing) * 28)",
      "@media (width>=48rem)": "120px",
    },
    color: "var(--color-cream-50)",
    opacity: "0",
  },
  lineSpan: {
    display: "block",
  },
  layerDiv: {
    position: "absolute",
    inset: "0",
  },
  layerDiv2: {
    position: "absolute",
    inset: "0",
    willChange: "transform",
  },
});
/** A part that belongs to one hour shows at that hour (data-scene on <html>), fading in and out as the hour changes. */
const AT: Record<Scene, string> = { morning: "morning:opacity-100", day: "day:opacity-100", evening: "evening:opacity-100", night: "night:opacity-100" };
/** The hour's own button looks pressed while the farm is at that hour. */
const PRESSED: Record<Scene, string> = { morning: "morning:bg-wheat", day: "day:bg-wheat", evening: "evening:bg-wheat", night: "night:bg-wheat" };
/** The plants in front of the camera that frame the village in the game (apps/web/src/farm/canvas): at the hero's corners, mostly past its edges. */
const framingStyles = stylex.create({
  branchLeft: {
    top: { default: "-44px", "@media (width >= 64rem)": "-66px" },
    left: { default: "-60px", "@media (width >= 64rem)": "-90px" },
    width: { default: "206px", "@media (width >= 64rem)": "309px" },
  },
  branchRight: {
    top: { default: "-48px", "@media (width >= 64rem)": "-72px" },
    right: { default: "-52px", "@media (width >= 64rem)": "-78px" },
    width: { default: "194px", "@media (width >= 64rem)": "291px" },
  },
  bushLeft: {
    bottom: { default: "-72px", "@media (width >= 64rem)": "-108px" },
    left: { default: "-64px", "@media (width >= 64rem)": "-96px" },
    width: { default: "232px", "@media (width >= 64rem)": "348px" },
  },
  bushRight: {
    right: { default: "-68px", "@media (width >= 64rem)": "-102px" },
    bottom: { default: "-64px", "@media (width >= 64rem)": "-96px" },
    width: { default: "236px", "@media (width >= 64rem)": "354px" },
  },
});
const FRAME = ["branchLeft", "branchRight", "bushLeft", "bushRight"] as const;
export type Frame = Record<(typeof FRAME)[number], string>;
/** The first screen of scrolling, while the scene holds on the screen (the hero is two screens high). */
const HOLDING = ["start start", "end end"] as ["start start", "end end"];
/** The second, while the scene goes up off the screen. */
const LEAVING = ["end end", "end start"] as ["end end", "end start"];
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
/** The dog's round by day: sits, swishes its tail, looks back now and then. */
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
  /** The frame's plants. */
  frame: Frame;
  github: string;
}
export default function Hero(props: Props) {
  const root = createElementRef<HTMLElement>();
  const [scene, setScene] = createSignal<Scene>("morning");
  let wanted: Scene = "morning";
  let disposed = false;
  // The pointer over the scene, -0.5 to 0.5 each way, followed on a spring; and how far the page has scrolled.
  const px = springValue<number>(0, { stiffness: 50, damping: 18 });
  const py = springValue<number>(0, { stiffness: 50, damping: 18 });
  onCleanup(() => {
    disposed = true;
    px.destroy();
    py.destroy();
  });
  // While the scene holds: the opening words stay a little, then rise and are gone as day comes; the hint to scroll
  // goes at once.
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
    const hour = TURNS.findLast(([from]) => q >= from)![1];
    if (hour !== wanted) void relight(hour);
  });
  /** An hour's button: the page goes to where the farm is at that hour. */
  function go(s: Scene) {
    const hero = root.get();
    if (!hero) return;
    window.scrollTo({ top: POINTS[s] * (hero.offsetHeight - innerHeight), behavior: reducedMotion() ? "auto" : "smooth" });
  }
  /** The farm's lights and poses at another hour: the farmer's pose loads first, then the farm turns to that light. */
  async function relight(next: Scene) {
    wanted = next;
    setScene(next);
    const element = root.get();
    const pictures = element ? picturesOf(element, next) : [];
    await Promise.all(
      pictures.map((img) => {
        if (!img.getAttribute("src")) img.src = img.dataset.src ?? "";
        return img.decode().catch(() => {});
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
      <section ref={root.set} id="top" aria-label={props.copy.name} {...stylex.attrs(viewStyles.heroSection)}>
        <div onPointerMove={point} onPointerLeave={leave} {...stylex.attrs(viewStyles.heroDiv)}>
          {/* The scene keeps its 3:2 and covers the hero, a little bigger, so the layers have room to part. */}
          <div aria-hidden="true" {...stylex.attrs(viewStyles.heroDiv2)}>
            {/* The farm: its picture, the smoke and the fireflies over it, the farmer and the dog on the hill. */}
            <Layer lag={0.5} zoom={1.06} origin="62% 60%" point={16} hero={root} px={px} py={py}>
              <div class="animate-pan absolute inset-0 origin-[60%_55%]">
                {/* The hours' pictures: the day's at the bottom, each later one fading in over it as the page goes. */}
                <img
                  data-scene="morning"
                  data-src={props.backgrounds.morning}
                  src={props.backgrounds.morning}
                  alt=""
                  draggable={false}
                  class="pixelated absolute inset-0 size-full max-w-none select-none"
                />
                <Comes hour="day" src={props.backgrounds.day} hero={root} />
                <Comes hour="evening" src={props.backgrounds.evening} hero={root} />
                <Comes hour="night" src={props.backgrounds.night} hero={root} />
                <noscript>
                  <img src={props.backgrounds.morning} alt="" {...stylex.attrs(viewStyles.heroImg)} />
                </noscript>
                {PUFFS.map((p, i) => {
                  const s = sprite(p.sprite, p.scale);
                  return (
                    <img
                      src={props.art[s.name]}
                      alt=""
                      draggable={false}
                      fetchpriority="low"
                      class="animate-puff lit-smoke pixelated absolute top-(--y0) left-(--x0) max-w-none origin-bottom -translate-x-1/2 -translate-y-full opacity-0 select-none"
                      style={{
                        ...vars({ "--x0": pct(CHIMNEY.x), "--y0": pct(CHIMNEY.y) }),
                        width: pct(s.w),
                        "animation-duration": `${PUFF_SECONDS}s`,
                        "animation-delay": `${-(i * PUFF_SECONDS) / PUFFS.length}s`,
                      }}
                    />
                  );
                })}
                {(["evening", "night"] as const).map((at) => (
                  <div class={cx("absolute inset-0 opacity-0 transition-opacity duration-900", AT[at])}>
                    {flies[at].map((f, i) => (
                      <span
                        class="animate-firefly bg-firefly absolute shadow-[0_0_6px_2px_rgb(255_214_90/0.75)]"
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
                  class={cx("animate-breathe absolute origin-bottom opacity-0 transition-opacity duration-900", AT[s])}
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
                    class="lit-farmer pixelated block size-full max-w-none select-none"
                  />
                  {s === "night" && (
                    <span class="animate-lantern absolute top-[70%] left-[4%] aspect-square w-[34%] -translate-1/2 rounded-full bg-[radial-gradient(circle,rgb(255_210_110/0.55),rgb(255_170_60/0.2)_45%,transparent_70%)] mix-blend-screen" />
                  )}
                </div>
              ))}
              <Dog scene={scene()} art={props.art} />
            </Layer>
            {/* The clouds, the farthest. */}
            <Layer lag={0.62} zoom={1.03} origin="50% 30%" point={8} hero={root} px={px} py={py}>
              {CLOUDS.map((c) => {
                const s = sprite(c.sprite, c.scale);
                return (
                  <img
                    src={props.art[s.name]}
                    alt=""
                    draggable={false}
                    fetchpriority="low"
                    class="animate-cloud lit-sky pixelated absolute left-0 max-w-none select-none"
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
            {/* The plants along the bottom, nearer. */}
            <Layer lag={0.28} zoom={1.12} origin="50% 100%" point={36} hero={root} px={px} py={py}>
              {/* Seeds blow off the dandelions by day; at night they rest. */}
              <div class="night:opacity-0 absolute inset-0 transition-opacity duration-900">
                {SEEDS.map((seed) => {
                  const s = sprite(seed.sprite, 0.22);
                  return (
                    <span
                      class="animate-seed absolute top-[86%] left-(--x0) opacity-0"
                      style={{
                        ...vars({ "--x0": pct(seed.from) }),
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
                        class="animate-seed-spin lit-ground pixelated block w-full max-w-none"
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
                    class="animate-sway lit-ground pixelated absolute bottom-0 max-w-none origin-bottom select-none"
                    style={{
                      ...vars({ "--lean": `${p.lean}deg` }),
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
          <Layer lag={-0.08} zoom={1.3} origin="50% 50%" point={64} hero={root} px={px} py={py} styles={viewStyles.framingLayer}>
            {FRAME.map((f) => (
              <img src={props.frame[f]} alt="" aria-hidden="true" draggable={false} {...domAttrs(viewStyles.framingImage, framingStyles[f])} />
            ))}
          </Layer>

          {/* The words over the scene: at the left as on the game's title screen, at the bottom on a narrow screen, on a
            shade that stays while they change. */}
          <div
            aria-hidden="true"
            class="from-shade/75 via-shade/35 md:from-shade/55 md:via-shade/25 pointer-events-none absolute inset-0 z-2 bg-linear-0 via-55% to-transparent to-80% md:bg-linear-90 md:via-45% md:to-70%"
          />
          <div
            ref={words.set}
            class="pointer-events-none absolute inset-0 z-2 flex flex-col justify-end gap-[18px] px-[clamp(16px,6vw,96px)] pt-24 pb-24 text-cream-50 *:pointer-events-auto md:justify-center md:pb-[120px]"
          >
            <div class="motion-safe:animate-float">
              <h1 class="text-shadow-title text-[clamp(48px,7vw,96px)]">
                <span {...stylex.attrs(viewStyles.heroSpan)}>{props.copy.name}</span>
                <span aria-hidden="true">
                  {[...props.copy.name].map((ch, i) => (
                    <span
                      class="motion-safe:animate-pop inline-block"
                      style={{
                        "animation-delay": `${i * stagger}ms`,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
                <span {...stylex.attrs(viewStyles.heroSpan2)}>{props.copy.aka}</span>
              </h1>
            </div>
            <p
              class="motion-safe:animate-in font-pixel text-[clamp(30px,4.2vw,54px)]/[1.15] text-wheat text-shadow-ink"
              style={{
                "animation-delay": `${after}ms`,
              }}
            >
              {props.copy.tagline}
            </p>
            <p
              class="motion-safe:animate-in font-pixel text-[clamp(20px,2.4vw,30px)]/[1.3] text-shadow-ink"
              style={{
                "animation-delay": `${after + 90}ms`,
              }}
            >
              {props.copy.verses.morning.join("")}
            </p>
            <p
              class="text-shadow-thin motion-safe:animate-in max-w-[34em] text-base sm:text-lg"
              style={{
                "animation-delay": `${after + 180}ms`,
              }}
            >
              {props.copy.lead}
            </p>
            <div
              class="motion-safe:animate-in mt-2 flex flex-wrap gap-3.5"
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

          <div role="group" aria-label={props.copy.hours} {...stylex.attrs(viewStyles.heroDiv3)}>
            <span {...stylex.attrs(viewStyles.heroSpan3)}>{props.copy.hours}</span>
            {SCENES.map((s) => (
              <button
                type="button"
                data-testid={`hero-hour-${s}`}
                aria-pressed={s === scene() ? "true" : "false"}
                onClick={() => go(s)}
                class={cx("shadow-hard-sm cursor-pointer border-2 border-bark-900 bg-cream-50 px-2.5 py-1.5 text-bark-900 hover:bg-cream-hover", PRESSED[s])}
              >
                {props.copy.hour[s]}
              </button>
            ))}
          </div>
          <a ref={hint.set} href="#parade" {...stylex.attrs(viewStyles.heroA)}>
            {props.copy.scroll}
            <img src={props.hint} alt="" class="pixelated motion-safe:animate-hint w-5 rotate-90" />
          </a>
        </div>
      </section>
    </>
  );
}
/** A later hour's picture, fading in over the earlier ones as the page goes through the holding screen (and out as it comes back). */
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
      class="pixelated absolute inset-0 size-full max-w-none opacity-0 select-none"
    />
  );
}
/** An hour's line of the verse, big where the opening words were. It shows and hides for everyone. */
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
    <div ref={seen.set} {...stylex.attrs(viewStyles.lineDiv)}>
      <p ref={rise.set} class="text-shadow-title font-pixel text-[clamp(34px,5.2vw,72px)]/[1.25]">
        {props.verse.map((half) => (
          <span {...stylex.attrs(viewStyles.lineSpan)}>{half}</span>
        ))}
      </p>
    </div>
  );
}
/** One layer of the scene. While the scene holds, it pushes in toward its origin by its zoom (the nearer, the more). */
function Layer(props: {
  lag: number;
  zoom: number;
  origin: string;
  point: number;
  hero: ElementRef<HTMLElement>;
  px: MotionValue<number>;
  py: MotionValue<number>;
  styles?: stylex.StyleXStyles;
  children: JSX.Element;
}) {
  const away = createScrollAnimation<HTMLDivElement>(props.hero, LEAVING, () => [
    { keyframes: { transform: ["translateY(0px)", `translateY(${props.lag * innerHeight}px)`] } },
  ]);
  const closer = createScrollAnimation<HTMLDivElement>(props.hero, HOLDING, () => [{ keyframes: { transform: ["scale(1)", `scale(${props.zoom})`] } }]);
  const x = readMotion(props.px);
  const y = readMotion(props.py);
  return (
    <div ref={away.set} {...domAttrs(viewStyles.layer, props.styles)}>
      <div
        ref={closer.set}
        {...stylex.attrs(viewStyles.layerDiv)}
        style={{
          "transform-origin": props.origin,
        }}
      >
        <div
          {...stylex.attrs(viewStyles.layerDiv2)}
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
/** The dog by the farmer: its round by day, asleep at night; it looks up and hops when the pointer comes by. */
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
        const [name, ms] = ROUND[at++ % ROUND.length]!;
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
      class="lit-ground pixelated absolute max-w-none -translate-x-1/2 select-none"
      style={{
        left: pct(PET.x),
        bottom: pct(1 - PET.bottom),
        width: pct(f().w),
      }}
    />
  );
}
