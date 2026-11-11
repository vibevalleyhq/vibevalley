import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, Show } from "solid-js";

import { Keyed } from "#/base/dom.tsx";
import { ready, useSprites } from "#/infra/query.ts";
import { styleProps } from "#/ui/positioner.ts";

import { type Cast, castSprite, type Pose, walkFrames } from "./cast";

const idle = stylex.keyframes({ "50%": { transform: "scale(1.012, 0.985)" } });
const walk = stylex.keyframes({ "50%": { transform: "translateY(-3px)" } });
const work = stylex.keyframes({
  "0%": { transform: "rotate(-2.5deg)" },
  "100%": { transform: "rotate(-2.5deg)" },
  "50%": { transform: "translateY(-3px) rotate(2.5deg)" },
});
const think = stylex.keyframes({
  "0%": { transform: "rotate(-1.5deg)" },
  "100%": { transform: "rotate(-1.5deg)" },
  "50%": { transform: "rotate(1.5deg)" },
});
const cheer = stylex.keyframes({
  "0%": { transform: "none", animationTimingFunction: "ease-out" },
  "20%": { transform: "translateY(-16px)", animationTimingFunction: "ease-in" },
  "40%": { transform: "scale(1.03, 0.97)" },
  "60%": { transform: "none" },
  "100%": { transform: "none" },
});
const worry = stylex.keyframes({
  "0%": { transform: "none" },
  "100%": { transform: "none" },
  "25%": { transform: "rotate(-3deg)" },
  "75%": { transform: "rotate(3deg)" },
});
const styles = stylex.create({
  placeholder: (height: number) => ({ height }),
  sprite: {
    display: "block",
    imageRendering: "pixelated",
    transformOrigin: "50% 100%",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  idle: { animationName: { default: idle, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "2.6s" },
  walk: { animationName: { default: walk, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "0.28s" },
  work: { animationName: { default: work, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "0.9s" },
  think: { animationName: { default: think, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "3.2s" },
  cheer: { animationName: { default: cheer, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "2.2s", animationTimingFunction: "linear" },
  worry: { animationName: { default: worry, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1.6s" },
});
const poses: Record<Pose, stylex.StyleXStyles> = {
  idle: styles.idle,
  walk: styles.walk,
  work: styles.work,
  think: styles.think,
  cheer: styles.cheer,
  worry: styles.worry,
};

const walkFps = 7;

/** A helper attention, walking, working…, `height` px tall, moving as the farm moves it. */
export function PoseSprite(props: { cast: Cast; pose: Pose; height: number }) {
  const sprites = useSprites();
  const [frame, setFrame] = createSignal(0);
  createEffect(
    () => props.pose,
    (pose) => {
      setFrame(0);
      if (pose !== "walk") return;
      const t = setInterval(() => setFrame((f) => f + 1), 1000 / walkFps);
      return () => clearInterval(t);
    },
  );
  return (
    <Show when={ready(sprites, undefined)} fallback={<span {...styleProps(styles.placeholder(props.height))} />}>
      {(sprites) => {
        const has = (n: string) => n in sprites();
        const name = () => {
          const frames = props.pose === "walk" ? walkFrames(props.cast, has) : [castSprite(props.cast, props.pose, has)];
          return frames[frame() % frames.length] ?? frames[0] ?? "";
        };
        const size = () => sprites()[name()] ?? { w: 1, h: 1 };
        // A new img for each pose restarts its animation.
        return (
          <Keyed key={props.pose}>
            {() => (
              <img
                src={`/pixel/${name()}.png`}
                alt=""
                draggable="false"
                {...styleProps([styles.sprite, poses[props.pose]], { height: `${props.height}px`, width: `${(size().w * props.height) / size().h}px` })}
              />
            )}
          </Keyed>
        );
      }}
    </Show>
  );
}
