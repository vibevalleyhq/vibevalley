// Ported from VibeValley apps/web/src/ui/Icon.tsx. reicon draws SVG; nsh has
// none, so the same path data (vv/icons.py → icons.ts) is drawn on Canvas.
// A canvas cannot inherit the text color (CSS currentColor): callers pass
// `color` (a color) or `tone` (a theme token), else it is `ink`.
import { Canvas, Path2D } from "nsh";

import { type IconName, type IconShape, icons } from "./icons";
import { tone as toneOf } from "./tone";

// The size ladder (docs/style/design.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

/** The marks keep their colour wherever they stand, over a caller's colour too: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, string>> = { check: "leaf", cross: "berry", warn: "wheat" };

const paths = new Map<string, Path2D>();
const pathOf = (d: string): Path2D => {
  let p = paths.get(d);
  if (!p) paths.set(d, (p = new Path2D(d)));
  return p;
};

export function Icon(props: { name: IconName; size?: IconSize | number; label?: string; color?: string; tone?: string; testID?: string }) {
  const size = () => props.size ?? 16;
  const color = () => {
    const fixed = iconTone[props.name];
    if (fixed) return toneOf(fixed);
    return props.color ?? toneOf(props.tone ?? "ink");
  };
  return (
    <Canvas
      testID={props.testID}
      accessible={props.label !== undefined}
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx) => {
        const shapes: readonly IconShape[] = icons[props.name];
        const c = color();
        cx.scale(size() / 24, size() / 24);
        for (const s of shapes) {
          const p = pathOf(s.d);
          cx.globalAlpha = s.opacity ?? 1;
          if (s.fill) {
            cx.fillStyle = c;
            cx.fill(p, s.evenodd ? "evenodd" : "nonzero");
          }
          if (s.stroke) {
            cx.strokeStyle = c;
            cx.lineWidth = s.stroke;
            cx.lineCap = s.cap ?? "butt";
            cx.lineJoin = s.join ?? "miter";
            cx.stroke(p);
          }
        }
      }}
    />
  );
}
