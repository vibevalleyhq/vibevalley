import type { JSX } from "@solidjs/web";
import type { MotionValue } from "motion";
import { createMemo, createSignal, onSettled } from "solid-js";

import { BACK, FIELD, JOB, NEAR, PACE, PLACES, START, branchAt, momentAt, stageOf, workAt, type BubbleIcon, type Moment, type StoryArt } from "../base/story";
import type { Copy } from "../i18n/zh";
import { createEntrance } from "../ui/entrance";
import { Icon } from "../ui/icons";
import { Presence } from "../ui/Presence";
import { createElementRef, createMotionValue, createScrollPosition, readMotion, reducedMotion, createReveal } from "../ui/scroll";
import { Section } from "../ui/ui";

const dotTones = {
  base: "bg-bark-900",
  branch: "bg-leaf-500",
  merge: "bg-wheat",
};

const viewStyles = {
  cutoutGeometry: (left: number, bottomY: number, width: number): JSX.CSSProperties => ({
    left: `${left}px`,
    top: `${bottomY}px`,
    width: `${width}px`,
  }),
  dotPosition: (left: string, top: number): JSX.CSSProperties => ({ left, top: `${top}px` }),
};

interface Props {
  copy: Copy["how"];
  /** Papertrails isometric diorama cutouts (src/base/story.ts). */
  art: StoryArt;
}

export default function How(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="how" title={props.copy.title}>
      <Story copy={props.copy} art={props.art} />
      <noscript>
        <Finished copy={props.copy} art={props.art} />
      </noscript>
    </Section>
  );
}

function Finished(props: Props) {
  const grown = PLACES.map((_, i) => stageOf(i, { place: PLACES.length - 1, working: true, work: 1, x: 0 }));
  return (
    <div>
      <div
        aria-hidden="true"
        class="relative mb-12 overflow-hidden rounded-lg border border-border-soft/50 bg-[image:var(--scene-field-background)] shadow-card"
      >
        <div class="grid grid-cols-4 items-end gap-5.5 px-3 sm:px-6 lg:px-8 pt-6 sm:pt-8">
          {grown.map((stage) => (
            <div class="flex justify-center">
              <img loading="lazy" src={props.art[stage]} alt="" class="w-24 sm:w-32 lg:w-40 max-w-none drop-shadow-[0_4px_6px_rgb(91_67_43_/_0.2)]" />
            </div>
          ))}
        </div>
        <div class="relative mt-2 mb-3 sm:mb-4 h-10 sm:h-12 border-y border-(--color-path-edge)/45 bg-[image:repeating-linear-gradient(90deg,var(--color-path)_0_28px,var(--color-path-groove)_28px_30px)]">
          <img
            loading="lazy"
            src={props.art.helper}
            alt=""
            class="absolute right-[5%] bottom-1.5 h-16 sm:h-22 lg:h-26 w-auto max-w-none drop-shadow-[0_4px_8px_rgb(91_67_43_/_0.28)]"
          />
        </div>
      </div>
      <div class="mb-12">
        <Branch copy={props.copy.git} now={{ place: PLACES.length - 1, working: true, work: 1, x: 0 }} />
      </div>
      <ol role="list" class="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-4 gap-5.5">
        {props.copy.steps.map((s, i) => (
          <li
            data-reveal={i * 80}
            class="relative mt-2.5 sm:mt-0 rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] px-5.5 pt-7 pb-5.5"
          >
            <span class="absolute -top-3.5 left-4.5 rounded-sm border border-leaf-700/80 bg-leaf-500 px-2.5 py-1 font-sans text-sm font-semibold leading-none text-paper-core shadow-card-sm">
              {i + 1}
            </span>
            <span class="mb-3 grid h-11 w-11 place-items-center rounded-md border border-border-soft/35 bg-cream-100 text-bark-800">
              <Icon name={s.icon} class="h-5.5 w-5.5" />
            </span>
            <h3 class="mb-1.5 text-xl">{s.title}</h3>
            <p class="text-[length:15px] text-bark-800">{s.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Position updates are imperative; only drawing state triggers reactive updates.
const sameDrawing = (a: Moment, b: Moment) => a.place === b.place && a.working === b.working && Math.floor(a.work * 40) === Math.floor(b.work * 40);

function Story(props: Props) {
  const track = createElementRef<HTMLDivElement>();
  const stage = createElementRef<HTMLDivElement>();
  const helper = createElementRef<HTMLImageElement>();
  const [scale, setScale] = createSignal(1);
  const [facing, setFacing] = createSignal<1 | -1>(1);
  let shows = 900;
  const [now, setNow] = createSignal<Moment>(() => momentAt(0));
  const camera = createMotionValue(0);
  const at = createMotionValue(START);
  const position = readMotion(at);
  const cameraFor = (x: number) => Math.min(Math.max(0, x - shows / 2), Math.max(0, FIELD.w - shows));

  onSettled(() => {
    const el = stage.get();
    if (!el) return;
    const measure = () => {
      const next = Math.max(0.65, el.clientHeight / FIELD.h);
      setScale(next);
      shows = el.clientWidth / next;
      camera.set(cameraFor(at.get()));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  });

  createScrollPosition((p) => {
    const m = momentAt(p);
    const place = PLACES[m.place];
    if (!place) throw new RangeError(`Invalid story place ${m.place}`);
    const x = reducedMotion() ? place.at : m.x;
    const dx = x - at.get();
    at.set(x);
    camera.set(cameraFor(x));
    if (!m.working && Math.abs(dx) > 0.2) setFacing(dx < 0 ? -1 : 1);
    else if (m.working) setFacing(1);
    setNow((before) => (sameDrawing(before, m) ? before : m));
  }, track);

  const work = createMemo(() => workAt(now().place, now().work));

  return (
    <div
      ref={track.set}
      data-testid="how-track"
      data-step={now().place}
      class="relative"
      style={{
        height: `${100 + PLACES.length * 80}svh`,
      }}
    >
      <div class="sticky top-16 flex h-[calc(100svh_-_4rem)] flex-col justify-center gap-5 py-4">
        <div
          ref={stage.set}
          data-testid="how-stage"
          aria-hidden="true"
          class="relative h-70 lg:h-96 shrink-0 overflow-hidden rounded-lg border border-border-soft/55 bg-(--color-story-sky) shadow-card-lg"
        >
          <div
            class="absolute top-0 left-0 [transform-origin:0_0]"
            style={{
              width: `${FIELD.w}px`,
              height: `${FIELD.h}px`,
              transform: `scale(${scale()})`,
            }}
          >
            <Sky camera={camera} />
            <Hills camera={camera} />
            <Pass camera={camera} pace={PACE.back}>
              {BACK.map((b) => (
                <Cutout src={props.art[b.name]} x={b.x} y={178} width={b.width} class="opacity-85 [filter:saturate(82%)]" />
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
                  src={props.art.helper}
                  alt=""
                  class="absolute bottom-0 left-0 w-18 -translate-x-1/2 max-w-none drop-shadow-[0_6px_10px_rgb(91_67_43_/_0.3)] transition-transform duration-150"
                  style={{
                    transform: facing() < 0 ? "scaleX(-1)" : "scaleX(1)",
                  }}
                />
                <Presence
                  value={now().working ? work().bubble : undefined}
                  enter={{ scale: [0.6, 1], opacity: [0, 1] }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  {(bubble, ref) => <Pop ref={ref} icon={bubble} x={0} y={-114} />}
                </Presence>
              </div>
            </Pass>
            <Pass camera={camera} pace={PACE.near}>
              {NEAR.map((n) => (
                <Cutout src={props.art[n.name]} x={n.x} y={FIELD.h + 18} width={n.width} class="opacity-90 drop-shadow-[0_4px_8px_rgb(91_67_43_/_0.25)]" />
              ))}
            </Pass>
          </div>
        </div>
        <Branch copy={props.copy.git} now={now()} />
        <Caption copy={props.copy} now={now()} />
      </div>
    </div>
  );
}

function Caption(props: { copy: Copy["how"]; now: Moment }) {
  return (
    <div class="relative min-h-42 rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] px-5.5 pt-4.5 pb-5">
      <ol role="list" class="mb-3.5 flex flex-wrap gap-2">
        {props.copy.steps.map((s, i) => (
          <li
            aria-current={i === props.now.place ? "step" : undefined}
            class={[
              "rounded-sm border px-2.5 py-1 font-sans text-xs font-semibold leading-none transition-[color,background-color,border-color] duration-250 ease-out",
              i < props.now.place
                ? "border-leaf-700/75 bg-leaf-500 text-paper-core"
                : i === props.now.place
                  ? "border-bark-800/70 bg-wheat text-bark-900 shadow-card-sm"
                  : "border-border-soft/35 bg-cream-100 text-bark-500",
            ]}
          >
            {i + 1} · {s.title}
          </li>
        ))}
      </ol>
      <Presence
        value={props.now.place}
        initial={false}
        enter={{ opacity: [0, 1], x: [14, 0] }}
        exit={{ opacity: 0, x: -14 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      >
        {(index, ref) => {
          const step = createMemo(() => {
            const value = props.copy.steps[index];
            if (!value) throw new RangeError(`Missing story copy for step ${index}`);
            return value;
          });
          return (
            <div ref={ref} class="flex items-start gap-4">
              <span class="grid h-12 w-12 flex-none place-items-center rounded-md border border-border-soft/35 bg-cream-100 text-bark-800">
                <Icon name={step().icon} class="h-6 w-6" />
              </span>
              <div>
                <h3 class="mb-1 text-xl">{step().title}</h3>
                <p class="text-[length:15px] text-bark-800">{step().text}</p>
              </div>
            </div>
          );
        }}
      </Presence>
    </div>
  );
}

/** A layer of the field passing the camera at its pace (the field itself at 1). */
function Pass(props: { camera: MotionValue<number>; pace: number; children: JSX.Element }) {
  return (
    <div
      class="absolute inset-0"
      style={{
        transform: `translateX(${-readMotion(props.camera)() * props.pace}px)`,
      }}
    >
      {props.children}
    </div>
  );
}

function Sky(props: { camera: MotionValue<number> }) {
  return (
    <>
      <div class="absolute inset-0 bg-[image:var(--scene-story-background)]" />
      <Pass camera={props.camera} pace={PACE.sky}>
        {[
          { y: 18, w: 96, d: 74, delay: -10 },
          { y: 42, w: 68, d: 98, delay: -60 },
          { y: 24, w: 84, d: 86, delay: -34 },
        ].map((c) => (
          <span
            class="absolute left-0 h-5 [animation-name:title-cloud] [animation-duration:160000ms] [animation-timing-function:linear] [animation-iteration-count:infinite] rounded-full bg-paper-core/80 shadow-story-cloud"
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

/** Soft Papertrails layered Jiangnan hills. */
function Hills(props: { camera: MotionValue<number> }) {
  const band = (top: number, rise: number, length: number, seed: number) => {
    const points: string[] = [`0,${FIELD.h}`];
    for (let x = 0; x <= FIELD.w; x += 24) {
      const y = Math.round(top - rise * (0.5 + 0.5 * Math.sin(x / length + seed)) - 6 * Math.sin(x / 38 + seed * 2));
      points.push(`${x},${y}`);
    }
    points.push(`${FIELD.w},${FIELD.h}`);
    return points.join(" ");
  };
  return (
    <>
      <Pass camera={props.camera} pace={PACE.hills * 0.6}>
        <svg class="absolute inset-0" width={FIELD.w} height={FIELD.h}>
          <polygon points={band(128, 34, 150, 1)} fill="#c2d2c7" />
        </svg>
      </Pass>
      <Pass camera={props.camera} pace={PACE.hills}>
        <svg class="absolute inset-0" width={FIELD.w} height={FIELD.h}>
          <polygon points={band(156, 22, 105, 3)} fill="#b8c79b" />
        </svg>
      </Pass>
    </>
  );
}

function Ground() {
  return (
    <>
      <div class="absolute inset-x-0 top-42 bottom-0 bg-[image:var(--scene-field-background)]" />
      <div class="absolute inset-x-0 top-56 h-8 border-y border-(--color-path-edge)/45 bg-[image:repeating-linear-gradient(90deg,var(--color-path)_0_22px,var(--color-path-groove)_22px_24px)]" />
    </>
  );
}

/** A Papertrails cutout standing on the field at (x, y) bottom-center. */
function Cutout(props: { src: string; x: number; y: number; width: number; class?: JSX.ClassValue | undefined }) {
  return (
    <img
      src={props.src}
      alt=""
      class={["absolute max-w-none -translate-x-1/2 -translate-y-full drop-shadow-[0_6px_8px_rgb(91_67_43_/_0.24)]", props.class]}
      style={viewStyles.cutoutGeometry(props.x, props.y, props.width)}
    />
  );
}

function Spot(props: { place: (typeof PLACES)[number]; index: number; now: Moment; art: StoryArt }) {
  const stage = createMemo(() => stageOf(props.index, props.now));
  const here = createMemo(() => props.now.place === props.index && props.now.working);
  const done = createMemo(() => props.now.place > props.index);
  const plot = createElementRef<HTMLDivElement>();
  createEntrance(plot, () => stage(), { scale: [0.82, 1] }, { duration: 0.34, ease: [0.22, 1, 0.36, 1] });
  return (
    <>
      <Cutout src={props.art[props.place.thing.name]} x={props.place.thing.x} y={FIELD.stand} width={props.place.thing.width} />
      <div
        ref={plot.set}
        class="absolute [transform-origin:50%_100%]"
        style={{
          left: `${props.place.plot}px`,
          top: `${FIELD.stand + 6}px`,
        }}
      >
        <Cutout src={props.art[stage()]} x={0} y={0} width={104} />
      </div>
      <Presence
        value={props.index === 0 && here() && props.now.work > 0.12 && props.now.work < 0.5 ? true : undefined}
        enter={{ scale: [0.6, 1], opacity: [0, 1] }}
        exit={{ scale: 0.6, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {(_, ref) => <Pop ref={ref} icon="chat" x={props.place.thing.x} y={FIELD.stand - 130} />}
      </Presence>
      <Presence
        value={props.index === 3 && (done() || (here() && props.now.work > 0.65)) ? true : undefined}
        enter={{ scale: [1.3, 1], opacity: [0, 1] }}
        exit={{}}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        {(_, ref) => (
          <div
            ref={ref}
            class="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper-core bg-leaf-500 p-2 text-paper-core shadow-card"
            style={{
              left: `${props.place.plot + 36}px`,
              top: `${FIELD.stand - 66}px`,
            }}
          >
            <Icon name="check" class="h-5 w-5" />
          </div>
        )}
      </Presence>
    </>
  );
}

function Pop(props: { icon: BubbleIcon; x: number; y: number; ref: (element: HTMLElement) => void }) {
  return (
    <div
      ref={props.ref}
      class="absolute [transform-origin:50%_100%]"
      style={{
        left: `${props.x}px`,
        top: `${props.y}px`,
      }}
    >
      <div class="absolute bottom-0 left-0 -translate-x-1/2 rounded-md border border-border-soft/60 bg-card p-2 text-bark-900 shadow-card">
        <Icon name={props.icon} class="h-5 w-5" />
      </div>
    </div>
  );
}

/** Where the branch's marks sit across the picture (shares of its width). */
const GIT = { fork: 0.16, commits: [0.36, 0.5, 0.64], join: 0.84 } as const;

function Branch(props: { copy: Copy["how"]["git"]; now: Moment }) {
  const b = createMemo(() => branchAt(props.now));
  const lane = 30;
  const main = 74;
  const head = createMemo(() => {
    const branch = b();
    if (branch.merged) return GIT.join - 0.06;
    if (branch.commits > 0) {
      const commit = GIT.commits[branch.commits - 1];
      if (commit === undefined) throw new RangeError(`Invalid branch commit count ${branch.commits}`);
      return commit;
    }
    return GIT.fork + 0.08;
  });
  const path = createMemo(() =>
    b().forked
      ? `M${GIT.fork * 100},${main} L${(GIT.fork + 0.06) * 100},${lane} L${head() * 100},${lane}${b().merged ? ` L${GIT.join * 100},${main}` : ""}`
      : "",
  );
  return (
    <div
      class="relative rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] px-4.5 pt-3.5 pb-2.5"
      aria-hidden="true"
    >
      <div class="flex flex-wrap items-center gap-2 font-mono text-xs sm:text-sm leading-none">
        <span
          class={[
            "rounded-sm border px-2.5 py-1.5 font-medium",
            b().forked ? "border-leaf-600/50 bg-leaf-300/75 text-bark-900" : "border-border-soft/35 bg-cream-100 text-bark-500",
          ]}
        >
          {props.copy.branch}
          <span class="hidden sm:inline"> · {props.copy.worktree}</span>
        </span>
        <span class="ml-auto rounded-sm border border-border-soft/35 bg-cream-100 px-2.5 py-1.5 tabular-nums text-bark-800">
          {b().commits} {props.copy.commits}
        </span>
        <span class="rounded-sm border border-border-soft/35 bg-cream-100 px-2.5 py-1.5 tabular-nums">
          <span class="text-leaf-700">+{b().plus}</span> <span class="text-berry">−{b().minus}</span>
        </span>
        <span
          class={[
            "rounded-sm border px-2.5 py-1.5 tabular-nums",
            b().tests === JOB.tests ? "border-leaf-700/75 bg-leaf-500 text-paper-core" : "border-border-soft/35 bg-cream-100 text-bark-800",
          ]}
        >
          {props.copy.tests} {b().tests}/{JOB.tests}
        </span>
      </div>
      <div class="relative mt-1 h-23">
        <svg class="absolute inset-0 w-full h-full" viewBox="0 0 100 92" preserveAspectRatio="none">
          <line
            x1="0"
            y1={main}
            x2="100"
            y2={main}
            stroke="var(--color-bark-800)"
            stroke-width="2.5"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
          {path() && (
            <path
              d={path()}
              fill="none"
              stroke="var(--color-leaf-600)"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          )}
        </svg>
        <span
          class="absolute left-0 font-mono text-xs font-semibold leading-none text-bark-800"
          style={{
            top: `${main - 22}px`,
          }}
        >
          main
        </span>
        <Dot x={GIT.fork} y={main} shown={b().forked} tone="base" />
        {GIT.commits.map((x, i) => (
          <Dot x={x} y={lane} shown={b().commits > i} tone="branch" />
        ))}
        <Dot x={GIT.join} y={main} shown={b().merged} tone="merge" large />
        <Presence
          value={b().merged ? true : undefined}
          enter={{ opacity: [0, 1], y: [6, 0] }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {(_, ref) => (
            <span
              ref={ref}
              class="absolute flex -translate-x-1/2 items-center gap-1 rounded-sm border border-bark-800/70 bg-wheat px-2 py-1 font-sans text-xs font-semibold leading-none whitespace-nowrap text-bark-900 shadow-card-sm"
              style={{
                left: `${GIT.join * 100}%`,
                top: `${main - 42}px`,
              }}
            >
              {props.copy.merged}
              <Icon name="check" class="w-3.5 h-3.5" />
            </span>
          )}
        </Presence>
      </div>
    </div>
  );
}

function Dot(props: { x: number; y: number; shown: boolean; tone: keyof typeof dotTones; large?: boolean }) {
  return (
    <Presence value={props.shown ? true : undefined} enter={{ scale: [0, 1] }} exit={{ scale: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      {(_, ref) => (
        <span
          ref={ref}
          class={[
            "absolute -translate-1/2 rounded-full border-2 border-paper-core shadow-card-sm",
            props.large === true ? "w-4 h-4" : "w-3 h-3",
            dotTones[props.tone],
          ]}
          style={viewStyles.dotPosition(`${props.x * 100}%`, props.y)}
        />
      )}
    </Presence>
  );
}
