import { Canvas, colorScheme, Path2D } from "nsh";

import { ICON_PATHS } from "../../design/iconPaths.gen";
import type { IconName } from "../../design/icons";
import { tone as toneOf } from "./tone";

const fixedIconTone: Partial<Record<IconName, string>> = {
  check: "leaf",
  cross: "berry",
  warn: "wheat",
};

const pathCache = new Map<string, Path2D>();

function cachedPath(d: string): Path2D {
  let path = pathCache.get(d);
  if (!path) {
    path = new Path2D(d);
    pathCache.set(d, path);
  }
  return path;
}

export function Icon(props: {
  readonly name: IconName;
  readonly size?: number;
  readonly label?: string;
  readonly color?: string;
  readonly tone?: string;
  readonly testID?: string;
}) {
  const size = () => props.size ?? 16;
  const color = () => {
    // Track colorScheme so light/dark switches redraw the canvas with the updated token hex.
    colorScheme();
    const fixed = fixedIconTone[props.name];
    if (fixed !== undefined) return toneOf(fixed);
    return props.color ?? toneOf(props.tone ?? "ink");
  };

  return (
    <Canvas
      testID={props.testID}
      accessible={props.label !== undefined}
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      class="shrink-0"
      style={{ width: size(), height: size() }}
      draw={(cx) => {
        const s = size();
        if (!Number.isFinite(s) || s <= 0) return;
        const paint = color();
        const shapes = ICON_PATHS[props.name];
        cx.save();
        cx.scale(s / 24, s / 24);
        for (const shape of shapes) {
          cx.globalAlpha = shape.opacity ?? 1;
          const path = cachedPath(shape.d);
          if (shape.fill) {
            cx.fillStyle = paint;
            if (shape.evenodd === true) cx.fill(path, "evenodd");
            else cx.fill(path);
          }
          if (shape.stroke !== undefined && shape.stroke > 0) {
            cx.strokeStyle = paint;
            cx.lineWidth = shape.stroke;
            cx.lineCap = shape.cap ?? "butt";
            cx.lineJoin = shape.join ?? "miter";
            cx.stroke(path);
          }
        }
        cx.restore();
      }}
    />
  );
}
