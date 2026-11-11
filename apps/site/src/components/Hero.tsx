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
import { PixelLink, domAttrs } from "./ui";

const sceneStyles = stylex.create({
  firefly: {
    position: "absolute",
    animationName: "title-firefly, title-blink",
    animationDuration: "6s, 2s",
    animationDelay: "0s, 0s",
    animationTimingFunction: "ease-in-out, ease-in-out",
    animationIterationCount: "infinite, infinite",
    animationDirection: "alternate, alternate",
    animationFillMode: "none, none",
    animationPlayState: "running, running",
    backgroundColor: "var(--color-firefly)",
    boxShadow: "var(--shadow-firefly)",
  },
  lantern: {
    position: "absolute",
    top: "70%",
    left: "4%",
    aspectRatio: "1",
    width: "34%",
    translate: "-50% -50%",
    animationName: "title-lantern",
    animationDuration: "2.4s",
    animationDelay: "0s",
    animationTimingFunction: "steps(6)",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    animationFillMode: "none",
    animationPlayState: "running",
    borderRadius: "9999px",
    backgroundImage: "var(--scene-lantern-background)",
    mixBlendMode: "screen",
  },
  title: {
    fontSize: "clamp(48px,7vw,96px)",
    textShadow: "var(--text-shadow-title)",
  },
  lead: {
    maxWidth: "34em",
    fontSize: {
      default: "var(--text-base)",
      "@media (width>=40rem)": "var(--text-lg)",
    },
    lineHeight: {
      default: "var(--leading-base)",
      "@media (width>=40rem)": "var(--leading-lg)",
    },
    textShadow: "var(--text-shadow-thin)",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-in",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": ".45s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "steps(5)",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "both",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
    pointerEvents: "auto",
  },
  verse: {
    fontFamily: "var(--font-pixel)",
    fontSize: "clamp(34px,5.2vw,72px)",
    lineHeight: "1.25",
    textShadow: "var(--text-shadow-title)",
  },
  sceneLayer: {
    position: "absolute",
    inset: "0",
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: ".9s",
  },
  farmer: {
    position: "absolute",
    transformOrigin: "bottom",
    animationName: "title-breathe",
    animationDuration: "3.2s",
    animationDelay: "0s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: ".9s",
  },
  seeds: {
    position: "absolute",
    inset: "0",
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: ".9s",
    opacity: "var(--scene-seed-opacity, 1)",
  },
  words: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    justifyContent: {
      default: "flex-end",
      "@media (width>=48rem)": "center",
    },
    gap: "18px",
    paddingInline: "clamp(16px,6vw,96px)",
    paddingTop: "6rem",
    paddingBottom: {
      default: "6rem",
      "@media (width>=48rem)": "120px",
    },
    color: "var(--color-cream-50)",
  },
  interactive: {
    pointerEvents: "auto",
  },
  hourButton: {
    cursor: "pointer",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    color: "var(--color-bark-900)",
    boxShadow: "2px 2px 0 var(--color-drop)",
  },
  shade: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
    zIndex: 2,
    backgroundImage: "var(--scene-hero-shade)",
  },
});

const styles = stylex.create({
  heroDiv: {
    position: "absolute",
    inset: "0",
    transformOrigin: "60% 55%",
    animationName: "title-pan",
    animationDuration: "70s",
    animationDelay: "0s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    animationFillMode: "none",
    animationPlayState: "running",
  },
  heroImg: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    maxWidth: "none",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
  heroImg2: {
    position: "absolute",
    top: "var(--y0)",
    left: "var(--x0)",
    maxWidth: "none",
    transformOrigin: "bottom",
    translate: "-50% -100%",
    animationName: "title-puff",
    animationDuration: "8s",
    animationDelay: "0s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    opacity: "0",
    filter: "var(--smoke)",
    transition: "filter .9s",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
  heroImg3: {
    display: "block",
    width: "100%",
    height: "100%",
    maxWidth: "none",
    filter: "var(--farmer)",
    transition: "filter .9s",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
  heroImg4: {
    position: "absolute",
    left: "0",
    maxWidth: "none",
    animationName: "title-cloud",
    animationDuration: "160s",
    animationDelay: "0s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    filter: "var(--sky)",
    transition: "filter .9s",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
  heroSpan: {
    position: "absolute",
    top: "86%",
    left: "var(--x0)",
    animationName: "title-seed-x, title-seed-y",
    animationDuration: "18s, 18s",
    animationDelay: "0s, 0s",
    animationTimingFunction: "ease-in-out, ease-in-out",
    animationIterationCount: "infinite, infinite",
    animationDirection: "normal, normal",
    animationFillMode: "none, none",
    animationPlayState: "running, running",
    opacity: "0",
  },
  heroImg5: {
    display: "block",
    width: "100%",
    maxWidth: "none",
    animationName: "title-seed-spin",
    animationDuration: "3s",
    animationDelay: "0s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    animationFillMode: "none",
    animationPlayState: "running",
    filter: "var(--ground)",
    transition: "filter .9s",
    imageRendering: "pixelated",
  },
  heroImg6: {
    position: "absolute",
    bottom: "0",
    maxWidth: "none",
    transformOrigin: "bottom",
    animationName: "title-sway",
    animationDuration: "4s",
    animationDelay: "0s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    animationFillMode: "none",
    animationPlayState: "running",
    filter: "var(--ground)",
    transition: "filter .9s",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
  heroDiv2: {
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-float",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "5s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "ease-in-out",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "infinite",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "none",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
  heroSpan2: {
    display: "inline-block",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-pop",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": ".5s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "steps(5)",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "both",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
  heroP: {
    fontFamily: "var(--font-pixel)",
    fontSize: "clamp(30px,4.2vw,54px)",
    lineHeight: "1.15",
    color: "var(--color-wheat)",
    textShadow: "2px 2px 0 var(--color-bark-900)",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-in",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": ".45s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "steps(5)",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "both",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
  heroP2: {
    fontFamily: "var(--font-pixel)",
    fontSize: "clamp(20px,2.4vw,30px)",
    lineHeight: "1.3",
    textShadow: "2px 2px 0 var(--color-bark-900)",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-in",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": ".45s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "steps(5)",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "both",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
  heroDiv3: {
    marginTop: "0.5rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.875rem",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-in",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": ".45s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "steps(5)",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "both",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
  heroImg7: {
    width: "1.25rem",
    rotate: "90deg",
    imageRendering: "pixelated",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "hint-bob",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1.2s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "steps(2)",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "infinite",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "none",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
  comesImg: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    maxWidth: "none",
    opacity: "0",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
  dogImg: {
    position: "absolute",
    maxWidth: "none",
    translate: "-50% 0",
    filter: "var(--ground)",
    transition: "filter .9s",
    WebkitUserSelect: "none",
    userSelect: "none",
    imageRendering: "pixelated",
  },
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
  heroDiv4: {
    containerType: "size",
    position: "sticky",
    top: "0",
    isolation: "isolate",
    height: "100svh",
    minHeight: "560px",
    overflow: "hidden",
    backgroundColor: "var(--color-dusk)",
  },
  heroDiv22: {
    containerType: "size",
    position: "absolute",
    top: "50%",
    left: "50%",
    aspectRatio: "3/2",
    width: "max(108cqw,162cqh)",
    translate: "-50% -50%",
  },
  heroImg8: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  heroSpan3: {
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
  heroSpan22: {
    marginTop: "0.625rem",
    display: "block",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
    color: "var(--color-wheat)",
    textShadow: "2px 2px 0 var(--color-bark-900)",
  },
  heroDiv32: {
    position: "absolute",
    bottom: {
      default: "1.25rem",
      "@media (width>=48rem)": "1.75rem",
    },
    left: {
      default: "1rem",
      "@media (width>=48rem)": "auto",
    },
    zIndex: "3",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
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
  heroSpan32: {
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
    translate: "-50% 0",
    justifyItems: "center",
    gap: "0.25rem",
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
    paddingTop: "6rem",
    paddingBottom: {
      default: "7rem",
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

const hourVisibility = stylex.create({
  morning: { opacity: "var(--scene-morning-opacity, 0)" },
  day: { opacity: "var(--scene-day-opacity, 0)" },
  evening: { opacity: "var(--scene-evening-opacity, 0)" },
  night: { opacity: "var(--scene-night-opacity, 0)" },
});
const hourButtonColors = stylex.create({
  morning: {
    backgroundColor: {
      default: "var(--scene-morning-button, var(--color-cream-50))",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-cream-hover)" },
    },
  },
  day: {
    backgroundColor: {
      default: "var(--scene-day-button, var(--color-cream-50))",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-cream-hover)" },
    },
  },
  evening: {
    backgroundColor: {
      default: "var(--scene-evening-button, var(--color-cream-50))",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-cream-hover)" },
    },
  },
  night: {
    backgroundColor: {
      default: "var(--scene-night-button, var(--color-cream-50))",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-cream-hover)" },
    },
  },
});
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
      <section ref={root.set} id="top" aria-label={props.copy.name} {...stylex.attrs(styles.heroSection)}>
        <div onPointerMove={point} onPointerLeave={leave} {...stylex.attrs(styles.heroDiv4)}>
          {/* The scene keeps its 3:2 and covers the hero, a little bigger, so the layers have room to part. */}
          <div aria-hidden="true" {...stylex.attrs(styles.heroDiv22)}>
            <Layer lag={0.5} zoom={1.06} origin="62% 60%" point={16} hero={root} px={px} py={py}>
              <div {...stylex.attrs(styles.heroDiv)}>
                <img
                  data-scene="morning"
                  data-src={props.backgrounds.morning}
                  src={props.backgrounds.morning}
                  alt=""
                  draggable={false}
                  {...stylex.attrs(styles.heroImg)}
                />
                <Comes hour="day" src={props.backgrounds.day} hero={root} />
                <Comes hour="evening" src={props.backgrounds.evening} hero={root} />
                <Comes hour="night" src={props.backgrounds.night} hero={root} />
                <noscript>
                  <img src={props.backgrounds.morning} alt="" {...stylex.attrs(styles.heroImg8)} />
                </noscript>
                {PUFFS.map((p, i) => {
                  const s = sprite(p.sprite, p.scale);
                  return (
                    <img
                      src={props.art[s.name]}
                      alt=""
                      draggable={false}
                      fetchpriority="low"
                      {...stylex.attrs(styles.heroImg2)}
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
                  <div {...stylex.attrs(sceneStyles.sceneLayer, hourVisibility[at])}>
                    {flies[at].map((f, i) => (
                      <span
                        {...stylex.attrs(sceneStyles.firefly)}
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
                  {...stylex.attrs(sceneStyles.farmer, hourVisibility[s])}
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
                    {...stylex.attrs(styles.heroImg3)}
                  />
                  {s === "night" && <span {...stylex.attrs(sceneStyles.lantern)} />}
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
                    {...stylex.attrs(styles.heroImg4)}
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
              <div {...stylex.attrs(sceneStyles.seeds)}>
                {SEEDS.map((seed) => {
                  const s = sprite(seed.sprite, 0.22);
                  return (
                    <span
                      {...stylex.attrs(styles.heroSpan)}
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
                        {...stylex.attrs(styles.heroImg5)}
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
                    {...stylex.attrs(styles.heroImg6)}
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
          <Layer lag={-0.08} zoom={1.3} origin="50% 50%" point={64} hero={root} px={px} py={py} styles={styles.framingLayer}>
            {FRAME.map((f) => (
              <img src={props.frame[f]} alt="" aria-hidden="true" draggable={false} {...domAttrs(styles.framingImage, framingStyles[f])} />
            ))}
          </Layer>

          {/* The shade stays while the words change. */}
          <div aria-hidden="true" {...stylex.attrs(sceneStyles.shade)} />
          <div ref={words.set} {...stylex.attrs(sceneStyles.words)}>
            <div {...stylex.attrs(styles.heroDiv2, sceneStyles.interactive)}>
              <h1 {...stylex.attrs(sceneStyles.title)}>
                <span {...stylex.attrs(styles.heroSpan3)}>{props.copy.name}</span>
                <span aria-hidden="true">
                  {[...props.copy.name].map((ch, i) => (
                    <span
                      {...stylex.attrs(styles.heroSpan2)}
                      style={{
                        "animation-delay": `${i * stagger}ms`,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
                <span {...stylex.attrs(styles.heroSpan22)}>{props.copy.aka}</span>
              </h1>
            </div>
            <p
              {...stylex.attrs(styles.heroP, sceneStyles.interactive)}
              style={{
                "animation-delay": `${after}ms`,
              }}
            >
              {props.copy.tagline}
            </p>
            <p
              {...stylex.attrs(styles.heroP2, sceneStyles.interactive)}
              style={{
                "animation-delay": `${after + 90}ms`,
              }}
            >
              {props.copy.verses.morning.join("")}
            </p>
            <p
              {...stylex.attrs(sceneStyles.lead)}
              style={{
                "animation-delay": `${after + 180}ms`,
              }}
            >
              {props.copy.lead}
            </p>
            <div
              {...stylex.attrs(styles.heroDiv3, sceneStyles.interactive)}
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

          <div role="group" aria-label={props.copy.hours} {...stylex.attrs(styles.heroDiv32)}>
            <span {...stylex.attrs(styles.heroSpan32)}>{props.copy.hours}</span>
            {SCENES.map((s) => (
              <button
                type="button"
                data-testid={`hero-hour-${s}`}
                aria-pressed={s === scene() ? "true" : "false"}
                onClick={() => go(s)}
                {...stylex.attrs(sceneStyles.hourButton, hourButtonColors[s])}
              >
                {props.copy.hour[s]}
              </button>
            ))}
          </div>
          <a ref={hint.set} href="#parade" {...stylex.attrs(styles.heroA)}>
            {props.copy.scroll}
            <img src={props.hint} alt="" {...stylex.attrs(styles.heroImg7)} />
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
  return <img ref={ref.set} data-scene={props.hour} data-src={props.src} alt="" draggable={false} {...stylex.attrs(styles.comesImg)} />;
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
    <div ref={seen.set} {...stylex.attrs(styles.lineDiv)}>
      <p ref={rise.set} {...stylex.attrs(sceneStyles.verse)}>
        {props.verse.map((half) => (
          <span {...stylex.attrs(styles.lineSpan)}>{half}</span>
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
    <div ref={away.set} {...domAttrs(styles.layer, props.styles)}>
      <div
        ref={closer.set}
        {...stylex.attrs(styles.layerDiv)}
        style={{
          "transform-origin": props.origin,
        }}
      >
        <div
          {...stylex.attrs(styles.layerDiv2)}
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
      {...stylex.attrs(styles.dogImg)}
      style={{
        left: pct(PET.x),
        bottom: pct(1 - PET.bottom),
        width: pct(f().w),
      }}
    />
  );
}
