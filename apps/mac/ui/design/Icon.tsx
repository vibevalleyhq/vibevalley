import { Canvas, colorScheme, Path2D } from "nsh";

import { richNative } from "../infra/rich";
import { ICON_PATHS } from "./iconPaths.gen";
import type { IconName } from "./icons";
import { tone as toneOf } from "./tone";

// The size ladder (docs/design/01-philosophy-and-tokens.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

/** The marks keep their colour wherever they stand, over a caller's colour too: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, string>> = { check: "leaf", cross: "berry", warn: "wheat" };

const pathCache = new Map<string, Path2D>();

function cachedPath(d: string): Path2D {
  let path = pathCache.get(d);
  if (!path) {
    path = new Path2D(d);
    pathCache.set(d, path);
  }
  return path;
}

export function Icon(props: { name: IconName; size?: number; label?: string; color?: string; tone?: string; testID?: string }) {
  const size = () => props.size ?? 16;
  const color = () => {
    // Read colorScheme so theme switches push the updated hex token into VvIcon and Canvas draws.
    colorScheme();
    const fixed = iconTone[props.name];
    if (fixed) return toneOf(fixed);
    return props.color ?? toneOf(props.tone ?? "ink");
  };
  const VvIcon = richNative()?.VvIcon;
  if (VvIcon) {
    return <VvIcon name={props.name} size={size()} color={color()} label={props.label ?? null} testID={props.testID} />;
  }
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
        const c = color();
        const shapes = ICON_PATHS[props.name];
        cx.save();
        cx.scale(s / 24, s / 24);
        for (const shape of shapes) {
          cx.globalAlpha = shape.opacity ?? 1;
          const path = cachedPath(shape.d);
          if (shape.fill) {
            cx.fillStyle = c;
            if (shape.evenodd === true) cx.fill(path, "evenodd");
            else cx.fill(path);
          }
          if (shape.stroke !== undefined && shape.stroke > 0) {
            cx.strokeStyle = c;
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
