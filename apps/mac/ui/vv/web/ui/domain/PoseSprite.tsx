// Ported from VibeValley apps/web/src/ui/domain/PoseSprite.tsx: a helper in
// a pose, `height` tall, walking through its frames. Not ported: each pose's
// CSS keyframes (style.css pose-*: a bob, a lean); nsh has no custom
// keyframes from TSX, so the other poses stand still.
import { Image, View } from "nsh";

import { useNow } from "../../base/dom";
import { ready, useSprites } from "../../infra/query";
import { useSpriteUrl } from "../pixel/atlas";
import { type Cast, castSprite, type Pose, walkFrames } from "./cast";

const walkMs = Math.round(1000 / 7);

function WalkingFrame(props: { cast: Cast; height: number }) {
  const sprites = useSprites();
  const url = useSpriteUrl();
  const tick = useNow(walkMs);
  const picture = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const frames = walkFrames(props.cast, (n) => n in all);
    const step = Math.floor(tick() / walkMs);
    const name = frames[step % frames.length] ?? frames[0] ?? "";
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

/** A helper standing, walking, working…, `height` tall. */
export function PoseSprite(props: { cast: Cast; pose: Pose; height: number }) {
  const sprites = useSprites();
  const url = useSpriteUrl();
  const standing = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const name = castSprite(props.cast, props.pose, (n) => n in all);
    const src = url(name);
    const size = all[name] ?? { w: 1, h: 1 };
    return src ? { src, width: (size.w * props.height) / size.h } : undefined;
  };
  return (
    <If
      when={props.pose === "walk"}
      else={
        <If when={standing()} else={<View style={{ height: props.height }} />}>
          {(p) => <Image src={p().src} style={{ height: props.height, width: p().width }} />}
        </If>
      }
    >
      <WalkingFrame cast={props.cast} height={props.height} />
    </If>
  );
}
