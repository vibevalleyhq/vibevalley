import type { JSX } from "@solidjs/web";
/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
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
import { Section, domAttrs } from "./ui";

const sceneStyles = stylex.create({
  finishedField: {
    position: "relative",
    marginBottom: "3rem",
    overflow: "hidden",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundImage: "var(--scene-field-background)",
    boxShadow: "4px 4px 0 var(--color-drop)",
  },
  storyScene: {
    position: "relative",
    height: {
      default: "264px",
      "@media (width>=64rem)": "396px",
    },
    flexShrink: "0",
    overflow: "hidden",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-story-sky)",
    boxShadow: "4px 4px 0 var(--color-drop)",
  },
  sky: {
    position: "absolute",
    inset: "0",
    backgroundImage: "var(--scene-story-background)",
  },
  cloud: {
    position: "absolute",
    left: "0",
    height: "0.625rem",
    animationName: "title-cloud",
    animationDuration: "160s",
    animationDelay: "0s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    borderRadius: "3px",
    backgroundColor: {
      default: "var(--color-cream-translucent)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-cream-50) 90%, transparent)",
    },
    boxShadow: "var(--shadow-story-cloud)",
  },
  ground: {
    position: "absolute",
    insetInline: "0",
    bottom: "0",
    backgroundImage: "var(--scene-field-background)",
  },
});

const dotTones = stylex.create({
  base: { backgroundColor: "var(--color-bark-900)" },
  branch: { backgroundColor: "var(--color-leaf-500)" },
  merge: { backgroundColor: "var(--color-wheat)" },
});

const viewStyles = stylex.create({
  sprite: { imageRendering: "pixelated", position: "absolute", maxWidth: "none", transformOrigin: "bottom" },
  spriteGeometry: (left: number, top: number, width: number, height: number) => ({ left, top, width, height }),
  distantBuilding: { scale: "75% 75%", filter: "brightness(95%) saturate(75%)" },
  distantDetail: { scale: "55% 55%", filter: "brightness(75%)" },
  halfSize: { scale: "50% 50%" },
  badge: {
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "var(--color-bark-900)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
  },
  captionStep: {
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-base)",
    lineHeight: "1",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "0.3s",
    transitionTimingFunction: "steps(3)",
  },
  completed: { backgroundColor: "var(--color-leaf-500)", color: "var(--color-cream-50)" },
  current: { backgroundColor: "var(--color-wheat)" },
  waiting: { backgroundColor: "var(--color-cream-100)", color: "var(--color-bark-500)" },
  forked: { backgroundColor: "var(--color-leaf-300)" },
  pendingTests: { backgroundColor: "var(--color-cream-100)" },
  count: { fontVariantNumeric: "tabular-nums" },
  dot: { position: "absolute", translate: "-50% -50%", borderWidth: 2, borderStyle: "solid", borderColor: "var(--color-bark-900)" },
  smallDot: { width: "0.75rem", height: "0.75rem" },
  largeDot: { width: "1rem", height: "1rem" },
  dotPosition: (left: string, top: number) => ({ left, top }),
  finishedDiv: {
    display: "grid",
    gridTemplateColumns: "repeat(4,minmax(0,1fr))",
    alignItems: "flex-end",
    gap: "22px",
    paddingInline: {
      default: "0.75rem",
      "@media (width>=40rem)": "1.5rem",
      "@media (width>=64rem)": "0",
    },
    paddingTop: {
      default: "1.5rem",
      "@media (width>=40rem)": "2rem",
    },
  },
  finishedDiv2: {
    display: "flex",
    justifyContent: "center",
  },
  finishedImg: {
    width: {
      default: "68px",
      "@media (width>=40rem)": "102px",
      "@media (width>=64rem)": "136px",
    },
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  finishedDiv3: {
    position: "relative",
    marginTop: "0.5rem",
    marginBottom: {
      default: "0.75rem",
      "@media (width>=40rem)": "1rem",
    },
    height: {
      default: "2.5rem",
      "@media (width>=40rem)": "3rem",
    },
    borderBlockStyle: "solid",
    borderBlockWidth: "2px",
    borderColor: "var(--color-path-edge)",
    backgroundImage: "repeating-linear-gradient(90deg,var(--color-path) 0 22px,var(--color-path-groove) 22px 26px)",
  },
  finishedImg2: {
    position: "absolute",
    right: "4%",
    bottom: "0.375rem",
    height: {
      default: "3.5rem",
      "@media (width>=40rem)": "84px",
      "@media (width>=64rem)": "7rem",
    },
    width: "auto",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  finishedDiv4: {
    marginBottom: "3rem",
  },
  finishedOl: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(4,minmax(0,1fr))",
    },
    gap: "22px",
  },
  finishedLi: {
    position: "relative",
    marginTop: {
      default: "0.625rem",
      "@media (width>=40rem)": "0",
    },
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    paddingInline: "22px",
    paddingTop: "26px",
    paddingBottom: "22px",
  },
  finishedSpan: {
    position: "absolute",
    top: "-1rem",
    left: "18px",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-leaf-500)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
  },
  finishedImg3: {
    marginBottom: "0.75rem",
    width: "3.5rem",
    height: "3.5rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  finishedH3: {
    marginBottom: "0.375rem",
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--leading-2xl)",
  },
  finishedP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    color: "var(--color-bark-800)",
  },
  howTrack: {
    position: "relative",
  },
  storyDiv: {
    position: "sticky",
    top: "4rem",
    display: "flex",
    height: "calc(100svh - 4rem)",
    flexDirection: "column",
    justifyContent: "center",
    gap: "1.25rem",
    paddingBlock: "1rem",
  },
  storyDiv2: {
    position: "absolute",
    top: "0",
    left: "0",
    transformOrigin: "0 0",
  },
  storyDiv3: {
    position: "absolute",
    top: "0",
    left: "0",
  },
  storyImg: {
    position: "absolute",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  captionDiv: {
    position: "relative",
    minHeight: "11rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    paddingInline: "1.25rem",
    paddingTop: "1rem",
    paddingBottom: "1.25rem",
  },
  captionOl: {
    marginBottom: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  captionDiv2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "1rem",
  },
  captionImg: {
    width: "3rem",
    height: "3rem",
    flex: "none",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  captionH3: {
    marginBottom: "0.25rem",
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--leading-2xl)",
  },
  passDiv: {
    position: "absolute",
    inset: "0",
  },
  groundDiv: {
    position: "absolute",
    insetInline: "0",
    borderBlockStyle: "solid",
    borderBlockWidth: "1px",
    borderColor: "var(--color-path-edge)",
    backgroundImage: "repeating-linear-gradient(90deg,var(--color-path) 0 11px,var(--color-path-groove) 11px 13px)",
  },
  spotDiv: {
    position: "absolute",
  },
  spotDiv2: {
    position: "absolute",
    top: "0",
  },
  popDiv: {
    position: "absolute",
    bottom: "0",
    left: "0",
    translate: "-50% 0",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    padding: "0.125rem",
    boxShadow: "1px 1px 0 var(--color-drop)",
  },
  popImg: {
    display: "block",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  branchDiv: {
    position: "relative",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    paddingInline: "1rem",
    paddingTop: "0.75rem",
    paddingBottom: "0.5rem",
  },
  branchDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    fontFamily: "var(--font-pixel)",
    fontSize: {
      default: "var(--text-sm)",
      "@media (width>=40rem)": "var(--text-base)",
    },
    lineHeight: {
      default: "1",
      "@media (width>=40rem)": "1",
    },
  },
  branchSpan: {
    display: {
      default: "none",
      "@media (width>=40rem)": "inline",
    },
  },
  branchSpan2: {
    marginLeft: "auto",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontVariantNumeric: "tabular-nums",
  },
  branchSpan3: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontVariantNumeric: "tabular-nums",
  },
  branchSpan4: {
    color: "var(--color-leaf-700)",
  },
  branchSpan5: {
    color: "var(--color-berry)",
  },
  branchDiv3: {
    position: "relative",
    marginTop: "0.25rem",
    height: "92px",
  },
  branchSvg: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
  },
  branchSpan6: {
    position: "absolute",
    left: "0",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-sm)",
    lineHeight: "1",
    color: "var(--color-bark-800)",
  },
  branchSpan7: {
    position: "absolute",
    display: "flex",
    translate: "-50% 0",
    alignItems: "center",
    gap: "0.25rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-wheat)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-sm)",
    lineHeight: "1",
    whiteSpace: "nowrap",
  },
  branchImg: {
    width: "0.875rem",
    height: "0.875rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
});
interface Props {
  copy: Copy["how"];
  icons: string[];
  /** Keys match the pose and prop lists in lib/story.ts. */
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
      <div aria-hidden="true" {...stylex.attrs(sceneStyles.finishedField)}>
        <div {...stylex.attrs(viewStyles.finishedDiv)}>
          {grown.map((stage) => (
            <div {...stylex.attrs(viewStyles.finishedDiv2)}>
              <img loading="lazy" src={props.art[stage].src} alt="" {...stylex.attrs(viewStyles.finishedImg)} />
            </div>
          ))}
        </div>
        <div {...stylex.attrs(viewStyles.finishedDiv3)}>
          <img loading="lazy" src={props.art.cheer.src} alt="" {...stylex.attrs(viewStyles.finishedImg2)} />
        </div>
      </div>
      <div {...stylex.attrs(viewStyles.finishedDiv4)}>
        <Branch copy={props.copy.git} now={{ place: PLACES.length - 1, working: true, work: 1, x: 0 }} check={props.art["mark-check"].src} />
      </div>
      <ol role="list" {...stylex.attrs(viewStyles.finishedOl)}>
        {props.copy.steps.map((s, i) => (
          <li data-reveal={i * 80} {...stylex.attrs(viewStyles.finishedLi)}>
            <span {...stylex.attrs(viewStyles.finishedSpan)}>{i + 1}</span>
            <img loading="lazy" src={props.icons[i]} alt="" {...stylex.attrs(viewStyles.finishedImg3)} />
            <h3 {...stylex.attrs(viewStyles.finishedH3)}>{s.title}</h3>
            <p {...stylex.attrs(viewStyles.finishedP)}>{s.text}</p>
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
  // Walking frames change without updating the reactive story state.
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
    const place = PLACES[m.place];
    if (!place) throw new RangeError(`Invalid story place ${m.place}`);
    const x = reducedMotion() ? place.at : m.x;
    const dx = x - at.get();
    at.set(x);
    camera.set(cameraFor(x));
    if (!reducedMotion() && !m.working && Math.abs(dx) > 0.01) {
      walked += Math.abs(dx);
      const frame = Math.floor(walked / 6) % 4;
      show(frame === 0 ? "side-1" : frame === 2 ? "side-2" : "side", dx < 0 ? -1 : 1);
      window.clearTimeout(rest);
      rest = window.setTimeout(() => show("side"), 160);
    }
    setNow((before) => (sameDrawing(before, m) ? before : m));
  }, track);
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
      const timer = window.setInterval(() => {
        const next = turns[++i % turns.length];
        if (next === undefined) throw new RangeError(`Invalid work animation frame ${i}`);
        show(next, 1);
      }, 220);
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
      {...stylex.attrs(viewStyles.howTrack)}
      style={{
        height: `${100 + PLACES.length * 80}svh`,
      }}
    >
      <div {...stylex.attrs(viewStyles.storyDiv)}>
        <div ref={stage.set} data-testid="how-stage" aria-hidden="true" {...stylex.attrs(sceneStyles.storyScene)}>
          <div
            {...stylex.attrs(viewStyles.storyDiv2)}
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
                <Sprite art={props.art[b.name]} x={b.x} y={74} styles={viewStyles.distantBuilding} />
              ))}
            </Pass>
            <Pass camera={camera} pace={PACE.field}>
              <Ground />
              {PLACES.map((place, i) => (
                <Spot place={place} index={i} now={now()} art={props.art} />
              ))}
              <div
                {...stylex.attrs(viewStyles.storyDiv3)}
                style={{
                  transform: `translate(${position()}px, ${FIELD.path}px)`,
                }}
              >
                <img
                  ref={helper.set}
                  src={props.art.side.src}
                  alt=""
                  {...stylex.attrs(viewStyles.storyImg)}
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
                <Sprite art={props.art[n.name]} x={n.x} y={FIELD.h + 30} styles={viewStyles.distantDetail} />
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
function Caption(props: { copy: Copy["how"]; icons: string[]; now: Moment }) {
  return (
    <div {...stylex.attrs(viewStyles.captionDiv)}>
      <ol role="list" {...stylex.attrs(viewStyles.captionOl)}>
        {props.copy.steps.map((s, i) => (
          <li
            aria-current={i === props.now.place ? "step" : undefined}
            {...stylex.attrs(
              viewStyles.badge,
              viewStyles.captionStep,
              i < props.now.place ? viewStyles.completed : i === props.now.place ? viewStyles.current : viewStyles.waiting,
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
        {(index, ref) => {
          const step = createMemo(() => {
            const value = props.copy.steps[index];
            if (!value) throw new RangeError(`Missing story copy for step ${index}`);
            return value;
          });
          return (
            <div ref={ref} {...stylex.attrs(viewStyles.captionDiv2)}>
              <img src={props.icons[index]} alt="" {...stylex.attrs(viewStyles.captionImg)} />
              <div>
                <h3 {...stylex.attrs(viewStyles.captionH3)}>{step().title}</h3>
                <p {...stylex.attrs(viewStyles.finishedP)}>{step().text}</p>
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
  const value = readMotion(props.camera);
  return (
    <div
      {...stylex.attrs(viewStyles.passDiv)}
      style={{
        transform: `translateX(${-value() * props.pace}px)`,
      }}
    >
      {props.children}
    </div>
  );
}
function Sky(props: { camera: MotionValue<number> }) {
  return (
    <>
      <div {...stylex.attrs(sceneStyles.sky)} />
      <Pass camera={props.camera} pace={PACE.sky}>
        {[
          { y: 8, w: 46, d: 70, delay: -10 },
          { y: 20, w: 30, d: 95, delay: -60 },
        ].map((c) => (
          <span
            {...stylex.attrs(sceneStyles.cloud)}
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
        <svg {...stylex.attrs(viewStyles.passDiv)} width={FIELD.w} height={FIELD.h} shape-rendering="crispEdges">
          <polygon points={band(60, 16, 70, 1)} fill="#8db5a0" />
        </svg>
      </Pass>
      <Pass camera={props.camera} pace={PACE.hills}>
        <svg {...stylex.attrs(viewStyles.passDiv)} width={FIELD.w} height={FIELD.h} shape-rendering="crispEdges">
          <polygon points={band(76, 10, 46, 3)} fill="#7aa95a" />
        </svg>
      </Pass>
    </>
  );
}
function Ground() {
  return (
    <>
      <div
        {...stylex.attrs(sceneStyles.ground)}
        style={{
          top: `${74}px`,
        }}
      />
      <div
        {...stylex.attrs(viewStyles.groundDiv)}
        style={{
          top: `${FIELD.path - 9}px`,
          height: `${14}px`,
        }}
      />
    </>
  );
}
/** A picture standing on the field at x, its feet at y. */
function Sprite(props: { art: Art; x: number; y: number; styles?: stylex.StyleXStyles }) {
  return (
    <img
      src={props.art.src}
      alt=""
      {...domAttrs(viewStyles.sprite, props.styles, viewStyles.spriteGeometry(props.x - props.art.ax, props.y - props.art.ay, props.art.w, props.art.h))}
    />
  );
}
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
        {...stylex.attrs(viewStyles.spotDiv)}
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
            {...stylex.attrs(viewStyles.spotDiv2)}
            style={{
              left: `${props.place.plot}px`,
            }}
          >
            <Sprite art={props.art["coins-stack"]} x={0} y={0} styles={viewStyles.halfSize} />
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
            {...stylex.attrs(viewStyles.spotDiv)}
            style={{
              left: `${props.place.plot + 24}px`,
              top: `${FIELD.stand - 34}px`,
            }}
          >
            <Sprite art={props.art["stamp-done"]} x={0} y={0} styles={viewStyles.halfSize} />
          </div>
        )}
      </Presence>
    </>
  );
}
function Pop(props: { art: Art; x: number; y: number; ref: (element: HTMLElement) => void }) {
  return (
    <div
      ref={props.ref}
      {...stylex.attrs(viewStyles.spotDiv)}
      style={{
        left: `${props.x}px`,
        top: `${props.y}px`,
        "transform-origin": "50% 100%",
      }}
    >
      <div {...stylex.attrs(viewStyles.popDiv)}>
        <img
          src={props.art.src}
          alt=""
          {...stylex.attrs(viewStyles.popImg)}
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
function Branch(props: { copy: Copy["how"]["git"]; now: Moment; check: string }) {
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
    <div {...stylex.attrs(viewStyles.branchDiv)} aria-hidden="true">
      <div {...stylex.attrs(viewStyles.branchDiv2)}>
        <span {...stylex.attrs(viewStyles.badge, b().forked ? viewStyles.forked : viewStyles.waiting)}>
          {props.copy.branch}
          <span {...stylex.attrs(viewStyles.branchSpan)}> · {props.copy.worktree}</span>
        </span>
        <span {...stylex.attrs(viewStyles.branchSpan2)}>
          {b().commits} {props.copy.commits}
        </span>
        <span {...stylex.attrs(viewStyles.branchSpan3)}>
          <span {...stylex.attrs(viewStyles.branchSpan4)}>+{b().plus}</span> <span {...stylex.attrs(viewStyles.branchSpan5)}>−{b().minus}</span>
        </span>
        <span {...stylex.attrs(viewStyles.badge, viewStyles.count, b().tests === JOB.tests ? viewStyles.completed : viewStyles.pendingTests)}>
          {props.copy.tests} {b().tests}/{JOB.tests}
        </span>
      </div>
      <div {...stylex.attrs(viewStyles.branchDiv3)}>
        <svg {...stylex.attrs(viewStyles.branchSvg)} viewBox="0 0 100 92" preserveAspectRatio="none" shape-rendering="crispEdges">
          <line x1="0" y1={main} x2="100" y2={main} stroke="var(--color-bark-900)" stroke-width="3" vector-effect="non-scaling-stroke" />
          {path() && <path d={path()} fill="none" stroke="var(--color-leaf-600)" stroke-width="3" vector-effect="non-scaling-stroke" />}
        </svg>
        <span
          {...stylex.attrs(viewStyles.branchSpan6)}
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
          transition={{ duration: 0.2, ease: steps(3) }}
        >
          {(_, ref) => (
            <span
              ref={ref}
              {...stylex.attrs(viewStyles.branchSpan7)}
              style={{
                left: `${GIT.join * 100}%`,
                top: `${main - 42}px`,
              }}
            >
              {props.copy.merged}
              <img src={props.check} alt="" {...stylex.attrs(viewStyles.branchImg)} />
            </span>
          )}
        </Presence>
      </div>
    </div>
  );
}
function Dot(props: { x: number; y: number; shown: boolean; tone: keyof typeof dotTones; large?: boolean }) {
  return (
    <Presence value={props.shown ? true : undefined} enter={{ scale: [0, 1] }} exit={{ scale: 0 }} transition={{ duration: 0.18, ease: steps(3) }}>
      {(_, ref) => (
        <span
          ref={ref}
          {...domAttrs(
            viewStyles.dot,
            props.large === true ? viewStyles.largeDot : viewStyles.smallDot,
            dotTones[props.tone],
            viewStyles.dotPosition(`${props.x * 100}%`, props.y),
          )}
        />
      )}
    </Presence>
  );
}
