import { useEffect, useState } from "react";
import { type Cast, castSprite, type Pose, walkFrames } from "../rules/cast";
import { useSprites } from "./Face";

const walkFps = 7;

/** A helper standing, walking, working…, `height` px tall, moving as the farm moves it. */
export function PoseSprite({ cast, pose, height }: { cast: Cast; pose: Pose; height: number }) {
  const sprites = useSprites().data;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (pose !== "walk") return;
    const t = setInterval(() => setFrame((f) => f + 1), 1000 / walkFps);
    return () => clearInterval(t);
  }, [pose]);
  if (!sprites) return <span style={{ height }} />;
  const has = (n: string) => n in sprites;
  const frames = pose === "walk" ? walkFrames(cast, has) : [castSprite(cast, pose, has)];
  const name = frames[frame % frames.length]!;
  const sp = sprites[name] ?? { w: 1, h: 1 };
  return (
    <img
      key={pose}
      src={`/pixel/${name}.png`}
      alt=""
      draggable={false}
      className={`pose pose-${pose} block [image-rendering:pixelated]`}
      style={{ height, width: (sp.w * height) / sp.h }}
    />
  );
}
