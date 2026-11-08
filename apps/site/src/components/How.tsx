/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { steps, type MotionValue } from "motion";
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";

import { createEntrance } from "../animation/entrance";
import { Presence } from "../animation/Presence";
import { createElementRef, createMotionValue, createScrollPosition, readMotion, reducedMotion, createReveal } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import {
  BACK,
  FIELD,
  JOB,
  NEAR,
  PACE,
  PLACES,
  START,
  branchAt,
  momentAt,
  stageOf,
  workAt,
  type Art,
  type Moment,
  type Pose,
  type StoryArt,
} from "../lib/story";
import { Section, cx } from "./ui";
interface Props {
  copy: Copy["how"];
  /** Each step's icon. */
  icons: string[];
  /** The field's pictures (Home.astro, from lib/story.ts's lists). */
  art: StoryArt;
}
export default function How(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <>
      <Section ref={root.set} id="how" title={props.copy.title}>
        <Story copy={props.copy} icons={props.icons} art={props.art} />
        <noscript>
          <Finished copy={props.copy} icons={props.icons} art={props.art} />
        </noscript>
      </Section>
    </>
  );
}
function Finished(props: Props) {
  const grown = PLACES.map((_, i) => stageOf(i, { place: PLACES.length - 1, working: true, work: 1, x: 0 }));
  return (
    <div>
      <div aria-hidden="true" class="shadow-hard-lg relative mb-12 overflow-hidden border-2 border-bark-900 bg-[linear-gradient(180deg,#8fbf5a,#76a046)]">
        <div class="grid grid-cols-4 items-end gap-[22px] px-3 pt-6 sm:px-6 sm:pt-8 lg:px-0">
          {grown.map((stage) => (
            <div class="flex justify-center">
              <img loading="lazy" src={props.art[stage].src} alt="" class="pixelated w-[68px] max-w-none sm:w-[102px] lg:w-[136px]" />
            </div>
          ))}
        </div>
        <div class="border-path-edge relative mt-2 mb-3 h-10 border-y-2 bg-[repeating-linear-gradient(90deg,var(--color-path)_0_22px,var(--color-path-groove)_22px_26px)] sm:mb-4 sm:h-12">
          <img loading="lazy" src={props.art.cheer.src} alt="" class="pixelated absolute right-[4%] bottom-1.5 h-14 w-auto max-w-none sm:h-[84px] lg:h-28" />
        </div>
      </div>
      <div class="mb-12">
        <Branch copy={props.copy.git} now={{ place: PLACES.length - 1, working: true, work: 1, x: 0 }} check={props.art["mark-check"].src} />
      </div>
      <ol role="list" class="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-4">
        {props.copy.steps.map((s, i) => (
          <li data-reveal={i * 80} class="panel relative mt-2.5 px-[22px] pt-[26px] pb-[22px] sm:mt-0">
            <span class="absolute -top-4 left-[18px] border-2 border-bark-900 bg-leaf-500 px-2.5 py-1.5 font-pixel text-lg/none text-cream-50">{i + 1}</span>
            <img loading="lazy" src={props.icons[i]} alt="" class="pixelated mb-3 size-14 object-contain" />
            <h3 class="mb-1.5 text-2xl">{s.title}</h3>
            <p class="text-base text-bark-800">{s.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
/** Two moments draw the same: the same step, the same pose and bubble, the same stages (the helper's place is not drawn by React). */
const sameDrawing = (a: Moment, b: Moment) => a.place === b.place && a.working === b.working && Math.floor(a.work * 40) === Math.floor(b.work * 40);
function Story(props: Props) {
  const track = createElementRef<HTMLDivElement>();
  const stage = createElementRef<HTMLDivElement>();
  const helper = createElementRef<HTMLImageElement>();
  // The field's size on the screen: k screen pixels to an art pixel, and how much of the field shows across.
  const [k, setK] = createSignal(3);
  let shows = 373;
  const [now, setNow] = createSignal<Moment>(() => momentAt(0));
  const camera = createMotionValue(0);
  const at = createMotionValue(START);
  const position = readMotion(at);
  const cameraFor = (x: number) => Math.min(Math.max(0, x - shows / 2), Math.max(0, FIELD.w - shows));
  onSettled(() => {
    const el = stage.get();
    if (!el) return;
    const measure = () => {
      const scale = Math.max(1, Math.round(el.clientHeight / FIELD.h));
      setK(scale);
      shows = el.clientWidth / scale;
      camera.set(cameraFor(at.get()));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  });
  // The helper's pose, drawn by hand (not by React), so it can change with every step it takes.
  let pose: {
    name: Pose;
    facing: 1 | -1;
  } = { name: "side", facing: 1 };
  function show(name: Pose, facing: 1 | -1 = pose.facing) {
    const img = helper.get();
    const a = props.art[name];
    if (!img) return;
    pose = { name, facing };
    img.src = a.src;
    img.style.left = `${-a.ax}px`;
    img.style.top = `${-a.ay}px`;
    img.style.transformOrigin = `${a.ax}px ${a.ay}px`;
    img.style.scale = facing < 0 ? "-1 1" : "1 1";
  }
  // Walking: a step every 6 art pixels (step, stand, step, stand), facing the way it goes, standing once the page rests.
  let walked = 0;
  let rest = 0;
  onCleanup(() => clearTimeout(rest));
  createScrollPosition((p) => {
    const m = momentAt(p);
    // For those who ask for less motion, the helper is where the step is done, without the walk there.
    const x = reducedMotion() ? PLACES[m.place]!.at : m.x;
    const dx = x - at.get();
    at.set(x);
    camera.set(cameraFor(x));
    if (!reducedMotion() && !m.working && Math.abs(dx) > 0.01) {
      walked += Math.abs(dx);
      show((["side-1", "side", "side-2", "side"] as const)[Math.floor(walked / 6) % 4]!, dx < 0 ? -1 : 1);
      window.clearTimeout(rest);
      rest = window.setTimeout(() => show("side"), 160);
    }
    setNow((before) => (sameDrawing(before, m) ? before : m));
  }, track);
  // At work: the place's pose, or two taking turns.
  const work = createMemo(() => workAt(now().place, now().work));
  const poses = createMemo(() => (now().working ? work().poses.join(" ") : ""));
  createEffect(
    () => poses(),
    () => {
      if (!poses()) return;
      window.clearTimeout(rest);
      const turns = work().poses;
      let i = 0;
      show(turns[0], 1);
      if (turns.length < 2) return;
      const timer = window.setInterval(() => show(turns[++i % turns.length]!, 1), 220);
      return () => window.clearInterval(timer);
    },
  );
  onSettled(() => {
    for (const a of Object.values(props.art)) new Image().src = a.src;
    show("side", 1);
  });
  return (
    // The story's length: a screen to hold the field, and most of one more for each step.
    <div
      ref={track.set}
      data-testid="how-track"
      data-step={now().place}
      class="relative"
      style={{
        height: `${100 + PLACES.length * 80}svh`,
      }}
    >
      <div class="sticky top-16 flex h-[calc(100svh-4rem)] flex-col justify-center gap-5 py-4">
        <div
          ref={stage.set}
          data-testid="how-stage"
          aria-hidden="true"
          class="shadow-hard-lg relative h-[264px] shrink-0 overflow-hidden border-2 border-bark-900 bg-[#9fc6d9] lg:h-[396px]"
        >
          <div
            class="absolute top-0 left-0 origin-top-left"
            style={{
              width: `${FIELD.w}px`,
              height: `${FIELD.h}px`,
              scale: k(),
            }}
          >
            <Sky camera={camera} />
            <Hills camera={camera} />
            <Pass camera={camera} pace={PACE.back}>
              {BACK.map((b) => (
                <Sprite art={props.art[b.name]} x={b.x} y={74} className="scale-75 brightness-95 saturate-75" />
              ))}
            </Pass>
            <Pass camera={camera} pace={PACE.field}>
              <Ground />
              {PLACES.map((place, i) => (
                <Spot place={place} index={i} now={now()} art={props.art} />
              ))}
              <div
                class="absolute top-0 left-0"
                style={{
                  transform: `translate(${position()}px, ${FIELD.path}px)`,
                }}
              >
                <img
                  ref={helper.set}
                  src={props.art.side.src}
                  alt=""
                  class="pixelated absolute max-w-none"
                  style={{
                    left: `${-props.art.side.ax}px`,
                    top: `${-props.art.side.ay}px`,
                  }}
                />
                <Presence
                  value={now().working ? work().bubble : undefined}
                  enter={{ scale: [0, 1], opacity: [0, 1] }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: steps(3) }}
                >
                  {(bubble, ref) => <Pop ref={ref} art={props.art[bubble]} x={0} y={-62} />}
                </Presence>
              </div>
            </Pass>
            <Pass camera={camera} pace={PACE.near}>
              {/* Low and small: they brush past the helper's feet, never over what it is doing. */}
              {NEAR.map((n) => (
                <Sprite art={props.art[n.name]} x={n.x} y={FIELD.h + 30} className="scale-55 brightness-75" />
              ))}
            </Pass>
          </div>
        </div>
        <Branch copy={props.copy.git} now={now()} check={props.art["mark-check"].src} />
        <Caption copy={props.copy} icons={props.icons} now={now()} />
      </div>
    </div>
  );
}
/** The words for the step the story is at, with the four steps as marks along the top. */
function Caption(props: { copy: Copy["how"]; icons: string[]; now: Moment }) {
  return (
    <div class="panel relative min-h-44 px-5 pt-4 pb-5">
      <ol role="list" class="mb-3 flex flex-wrap gap-2">
        {props.copy.steps.map((s, i) => (
          <li
            aria-current={i === props.now.place ? "step" : undefined}
            class={cx(
              "border-2 border-bark-900 px-2 py-1 font-pixel text-base/none transition-colors duration-300 ease-[steps(3)]",
              i < props.now.place ? "bg-leaf-500 text-cream-50" : i === props.now.place ? "bg-wheat" : "bg-cream-100 text-bark-500",
            )}
          >
            {i + 1} {s.title}
          </li>
        ))}
      </ol>
      <Presence
        value={props.now.place}
        initial={false}
        enter={{ opacity: [0, 1], x: [16, 0] }}
        exit={{ opacity: 0, x: -16 }}
        transition={{ duration: 0.24, ease: steps(4) }}
      >
        {(index, ref) => (
          <div ref={ref} class="flex items-start gap-4">
            <img src={props.icons[index]} alt="" class="pixelated size-12 flex-none object-contain" />
            <div>
              <h3 class="mb-1 text-2xl">{props.copy.steps[index]!.title}</h3>
              <p class="text-base text-bark-800">{props.copy.steps[index]!.text}</p>
            </div>
          </div>
        )}
      </Presence>
    </div>
  );
}
/** A layer of the field passing the camera at its pace (the field itself at 1). */
function Pass(props: { camera: MotionValue<number>; pace: number; children: JSX.Element }) {
  const value = readMotion(props.camera);
  return (
    <div
      class="absolute inset-0"
      style={{
        transform: `translateX(${-value() * props.pace}px)`,
      }}
    >
      {props.children}
    </div>
  );
}
/** The sky, barely moving, with a cloud or two drifting across. */
function Sky(props: { camera: MotionValue<number> }) {
  return (
    <>
      <div class="absolute inset-0 bg-[linear-gradient(180deg,#7fb6dc_0%,#a9d2e6_45%,#d5ead9_70%)]" />
      <Pass camera={props.camera} pace={PACE.sky}>
        {[
          { y: 8, w: 46, d: 70, delay: -10 },
          { y: 20, w: 30, d: 95, delay: -60 },
        ].map((c) => (
          <span
            class="animate-cloud absolute left-0 h-2.5 rounded-[3px] bg-cream-50/90 shadow-[4px_3px_0_rgb(255_255_255/0.6),-5px_4px_0_rgb(255_255_255/0.5)]"
            style={{
              top: `${c.y}px`,
              width: `${c.w}px`,
              "animation-duration": `${c.d}s`,
              "animation-delay": `${c.delay}s`,
            }}
          />
        ))}
      </Pass>
    </>
  );
}
/** Two bands of rolling hills, in steps of an art pixel. */
function Hills(props: { camera: MotionValue<number> }) {
  const band = (top: number, rise: number, length: number, seed: number) => {
    const points: string[] = [`0,${FIELD.h}`];
    for (let x = 0; x <= FIELD.w; x += 4) {
      const y = Math.round(top - rise * (0.5 + 0.5 * Math.sin(x / length + seed)) - 3 * Math.sin(x / 13 + seed * 2));
      points.push(`${x},${y}`, `${x + 4},${y}`);
    }
    points.push(`${FIELD.w},${FIELD.h}`);
    return points.join(" ");
  };
  return (
    <>
      <Pass camera={props.camera} pace={PACE.hills * 0.6}>
        <svg class="absolute inset-0" width={FIELD.w} height={FIELD.h} shape-rendering="crispEdges">
          <polygon points={band(60, 16, 70, 1)} fill="#8db5a0" />
        </svg>
      </Pass>
      <Pass camera={props.camera} pace={PACE.hills}>
        <svg class="absolute inset-0" width={FIELD.w} height={FIELD.h} shape-rendering="crispEdges">
          <polygon points={band(76, 10, 46, 3)} fill="#7aa95a" />
        </svg>
      </Pass>
    </>
  );
}
/** The field's ground: grass to the bottom, and the path the helper walks. */
function Ground() {
  return (
    <>
      <div
        class="absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,#8fbf5a,#76a046)]"
        style={{
          top: `${74}px`,
        }}
      />
      <div
        class="border-path-edge absolute inset-x-0 border-y bg-[repeating-linear-gradient(90deg,var(--color-path)_0_11px,var(--color-path-groove)_11px_13px)]"
        style={{
          top: `${FIELD.path - 9}px`,
          height: `${14}px`,
        }}
      />
    </>
  );
}
/** A picture standing on the field at x, its feet at y. */
function Sprite(props: { art: Art; x: number; y: number; className?: string }) {
  return (
    <img
      src={props.art.src}
      alt=""
      class={cx("pixelated absolute max-w-none origin-bottom", props.className)}
      style={{
        left: `${props.x - props.art.ax}px`,
        top: `${props.y - props.art.ay}px`,
        width: `${props.art.w}px`,
        height: `${props.art.h}px`,
      }}
    />
  );
}
/** One place: its thing, its plot at the stage the story has it at, and what turns up there. */
function Spot(props: { place: (typeof PLACES)[number]; index: number; now: Moment; art: StoryArt }) {
  const stage = createMemo(() => stageOf(props.index, props.now));
  const here = createMemo(() => props.now.place === props.index && props.now.working);
  const done = createMemo(() => props.now.place > props.index);
  const plot = createElementRef<HTMLDivElement>();
  createEntrance(plot, () => stage(), { scale: [0.7, 1] }, { duration: 0.3, ease: steps(3) });
  return (
    <>
      <Sprite art={props.art[props.place.thing.name]} x={props.place.thing.x} y={FIELD.stand} />
      <div
        ref={plot.set}
        class="absolute"
        style={{
          left: `${props.place.plot}px`,
          top: `${FIELD.stand}px`,
          "transform-origin": "50% 100%",
        }}
      >
        <Sprite art={props.art[stage()]} x={0} y={0} />
      </div>
      <Presence
        value={props.index === 0 && here() && props.now.work > 0.12 && props.now.work < 0.5 ? true : undefined}
        enter={{ scale: [0, 1], opacity: [0, 1] }}
        exit={{ scale: 0, opacity: 0 }}
        transition={{ duration: 0.22, ease: steps(3) }}
      >
        {(_, ref) => <Pop ref={ref} art={props.art["act-speaking_text"]} x={props.place.thing.x} y={FIELD.stand - 66} />}
      </Presence>
      <Presence
        value={props.index === 3 && here() && props.now.work > 0.45 ? true : undefined}
        enter={{ opacity: [0, 1, 1, 0], y: [FIELD.stand - 46, FIELD.stand - 86] }}
        exit={{}}
        transition={{ duration: 1.4, ease: steps(7) }}
      >
        {(_, ref) => (
          <div
            ref={ref}
            class="absolute top-0"
            style={{
              left: `${props.place.plot}px`,
            }}
          >
            <Sprite art={props.art["coins-stack"]} x={0} y={0} className="scale-50" />
          </div>
        )}
      </Presence>
      <Presence
        value={props.index === 3 && (done() || (here() && props.now.work > 0.75)) ? true : undefined}
        enter={{ scale: [1.8, 1], opacity: [0, 1] }}
        exit={{}}
        transition={{ duration: 0.25, ease: steps(3) }}
      >
        {(_, ref) => (
          <div
            ref={ref}
            class="absolute"
            style={{
              left: `${props.place.plot + 24}px`,
              top: `${FIELD.stand - 34}px`,
            }}
          >
            <Sprite art={props.art["stamp-done"]} x={0} y={0} className="scale-50" />
          </div>
        )}
      </Presence>
    </>
  );
}
/** A bubble popping up at x, y with a picture in it. */
function Pop(props: { art: Art; x: number; y: number; ref: (element: HTMLElement) => void }) {
  return (
    <div
      ref={props.ref}
      class="absolute"
      style={{
        left: `${props.x}px`,
        top: `${props.y}px`,
        "transform-origin": "50% 100%",
      }}
    >
      <div class="absolute bottom-0 left-0 -translate-x-1/2 border border-bark-900 bg-cream-50 p-0.5 shadow-[1px_1px_0_var(--color-drop)]">
        <img
          src={props.art.src}
          alt=""
          class="pixelated block max-w-none"
          style={{
            width: `${Math.round(props.art.w * 0.55)}px`,
            height: `${Math.round(props.art.h * 0.55)}px`,
          }}
        />
      </div>
    </div>
  );
}
/** Where the branch's marks sit across the picture (shares of its width). */
const GIT = { fork: 0.16, commits: [0.36, 0.5, 0.64], join: 0.84 } as const;
/** The job's branch at a moment of the story, as a git graph: main along the bottom. */
function Branch(props: { copy: Copy["how"]["git"]; now: Moment; check: string }) {
  const b = createMemo(() => branchAt(props.now));
  const lane = 30;
  const main = 74;
  const head = createMemo(() => (b().merged ? GIT.join - 0.06 : b().commits > 0 ? GIT.commits[b().commits - 1]! : GIT.fork + 0.08));
  const path = createMemo(() =>
    b().forked
      ? `M${GIT.fork * 100},${main} L${(GIT.fork + 0.06) * 100},${lane} L${head() * 100},${lane}${b().merged ? ` L${GIT.join * 100},${main}` : ""}`
      : "",
  );
  return (
    <div class="panel relative px-4 pt-3 pb-2" aria-hidden="true">
      <div class="flex flex-wrap items-center gap-2 font-pixel text-sm/none sm:text-base/none">
        <span class={cx("border-2 border-bark-900 px-2 py-1", b().forked ? "bg-leaf-300" : "bg-cream-100 text-bark-500")}>
          {props.copy.branch}
          <span class="hidden sm:inline"> · {props.copy.worktree}</span>
        </span>
        <span class="ml-auto border-2 border-bark-900 bg-cream-100 px-2 py-1 tabular-nums">
          {b().commits} {props.copy.commits}
        </span>
        <span class="border-2 border-bark-900 bg-cream-100 px-2 py-1 tabular-nums">
          <span class="text-leaf-700">+{b().plus}</span> <span class="text-berry">−{b().minus}</span>
        </span>
        <span class={cx("border-2 border-bark-900 px-2 py-1 tabular-nums", b().tests === JOB.tests ? "bg-leaf-500 text-cream-50" : "bg-cream-100")}>
          {props.copy.tests} {b().tests}/{JOB.tests}
        </span>
      </div>
      <div class="relative mt-1 h-[92px]">
        <svg class="absolute inset-0 size-full" viewBox="0 0 100 92" preserveAspectRatio="none" shape-rendering="crispEdges">
          <line x1="0" y1={main} x2="100" y2={main} stroke="var(--color-bark-900)" stroke-width="3" vector-effect="non-scaling-stroke" />
          {path() && <path d={path()} fill="none" stroke="var(--color-leaf-600)" stroke-width="3" vector-effect="non-scaling-stroke" />}
        </svg>
        <span
          class="absolute left-0 font-pixel text-sm/none text-bark-800"
          style={{
            top: `${main - 22}px`,
          }}
        >
          main
        </span>
        <Dot x={GIT.fork} y={main} shown={b().forked} tone="bg-bark-900" />
        {GIT.commits.map((x, i) => (
          <Dot x={x} y={lane} shown={b().commits > i} tone="bg-leaf-500" />
        ))}
        <Dot x={GIT.join} y={main} shown={b().merged} tone="bg-wheat" large />
        <Presence
          value={b().merged ? true : undefined}
          enter={{ opacity: [0, 1], y: [6, 0] }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: steps(3) }}
        >
          {(_, ref) => (
            <span
              ref={ref}
              class="absolute flex -translate-x-1/2 items-center gap-1 border-2 border-bark-900 bg-wheat px-1.5 py-0.5 font-pixel text-sm/none whitespace-nowrap"
              style={{
                left: `${GIT.join * 100}%`,
                top: `${main - 42}px`,
              }}
            >
              {props.copy.merged}
              <img src={props.check} alt="" class="pixelated size-3.5 object-contain" />
            </span>
          )}
        </Presence>
      </div>
    </div>
  );
}
/** A commit on the graph: a square that pops on when it is made. */
function Dot(props: { x: number; y: number; shown: boolean; tone: string; large?: boolean }) {
  return (
    <Presence value={props.shown ? true : undefined} enter={{ scale: [0, 1] }} exit={{ scale: 0 }} transition={{ duration: 0.18, ease: steps(3) }}>
      {(_, ref) => (
        <span
          ref={ref}
          class={cx("absolute -translate-1/2 border-2 border-bark-900", props.large === true ? "size-4" : "size-3", props.tone)}
          style={{
            left: `${props.x * 100}%`,
            top: `${props.y}px`,
          }}
        />
      )}
    </Presence>
  );
}
