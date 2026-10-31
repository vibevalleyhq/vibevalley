import { createEffect, createSignal, Show } from "solid-js";

import { Keyed } from "@/base/util";
import { ready, useSprites } from "@/infra/query";

import { type Cast, castSprite, type Pose, walkFrames } from "./cast";

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
    <Show when={ready(sprites, undefined)} fallback={<span style={{ height: `${props.height}px` }} />}>
      {(sprites) => {
        const has = (n: string) => n in sprites();
        const name = () => {
          const frames = props.pose === "walk" ? walkFrames(props.cast, has) : [castSprite(props.cast, props.pose, has)];
          return frames[frame() % frames.length]!;
        };
        const size = () => sprites()[name()] ?? { w: 1, h: 1 };
        // A new img for each pose: its animation (the pose-* class) starts over.
        return (
          <Keyed key={props.pose}>
            {() => (
              <img
                src={`/pixel/${name()}.png`}
                alt=""
                draggable="false"
                class={["pose block [image-rendering:pixelated]", `pose-${props.pose}`]}
                style={{ height: `${props.height}px`, width: `${(size().w * props.height) / size().h}px` }}
              />
            )}
          </Keyed>
        );
      }}
    </Show>
  );
}
