import { Image, signal, View } from "nsh";

import { createEffect } from "../../../solid";
import { ready, useSprites } from "../../infra/query";
import { useSpriteUrl } from "../pixel/atlas";
import { type Cast, castSprite, type Pose, walkFrames } from "./cast";

const walkFps = 7;

/** A helper standing, walking, working…, `height` tall. */
export function PoseSprite(props: { cast: Cast; pose: Pose; height: number }) {
  const sprites = useSprites();
  const url = useSpriteUrl();
  const frame = signal(0);
  createEffect(
    () => props.pose,
    (pose) => {
      frame.set(0);
      if (pose !== "walk") return;
      const timer = setInterval(() => frame.set(frame() + 1), 1000 / walkFps);
      return () => clearInterval(timer);
    },
  );
  const picture = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const has = (n: string) => n in all;
    const frames = props.pose === "walk" ? walkFrames(props.cast, has) : [castSprite(props.cast, props.pose, has)];
    const name = frames[frame() % frames.length] ?? frames[0] ?? "";
    const src = url(name);
    const size = all[name] ?? { w: 1, h: 1 };
    return src ? { src, width: (size.w * props.height) / size.h } : undefined;
  };
  return (
    <If when={picture()} else={<View style={{ height: props.height }} />}>
      {(p) => <Image src={p().src} style={{ height: props.height, width: p().width }} />}
    </If>
  );
}
