import { Canvas, colorScheme, Path2D } from "nsh";

import { type IconName, type IconShape, icons } from "./icons";
import { tone as toneOf } from "./tone";

// The size ladder (docs/design/01-philosophy-and-tokens.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

/** The marks keep their colour wherever they stand, over a caller's colour too: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, string>> = { check: "leaf", cross: "berry", warn: "wheat" };

const paths = new Map<string, Path2D>();
const pathOf = (d: string): Path2D => {
  let p = paths.get(d);
  if (!p) paths.set(d, (p = new Path2D(d)));
  return p;
};

export function Icon(props: { name: IconName; size?: number; label?: string; color?: string; tone?: string; testID?: string }) {
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
        // Read reactive theme/props inside draw so Canvas's render_effect repaints on dark/light switches and prop updates.
        colorScheme();
        const shapes: readonly IconShape[] = icons[props.name];
        const c = color();
        const sz = size();
        if (sz <= 0) return;
        cx.scale(sz / 24, sz / 24);
        for (const s of shapes) {
          const p = pathOf(s.d);
          cx.globalAlpha = s.opacity ?? 1;
          if (s.fill === 1) {
            cx.fillStyle = c;
            cx.fill(p, s.evenodd === 1 ? "evenodd" : "nonzero");
          }
          if (s.stroke !== undefined && s.stroke > 0) {
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
