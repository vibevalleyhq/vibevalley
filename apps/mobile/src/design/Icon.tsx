import { Canvas, colorScheme, Path2D } from "nsh";

import { createIconPathCache, drawIconShapes, ICON_PATHS } from "../../design/iconPaths.gen";
import type { IconName } from "../../design/icons";
import { tone as toneOf } from "./tone";

const iconTone: Partial<Record<IconName, string>> = {
  check: "leaf",
  cross: "berry",
  warn: "wheat",
};

const cachedPath = createIconPathCache((d) => new Path2D(d));

/** Resolves an icon's hex color: explicit `color`, explicit `tone`, status fallback (`iconTone`), or `"ink"`. */
function resolveIconColor(props: { readonly name: IconName; readonly color?: string; readonly tone?: string }): string {
  // Track colorScheme so light/dark switches redraw the canvas with the updated token hex.
  colorScheme();
  if (props.color !== undefined) return props.color;
  if (props.tone !== undefined) return toneOf(props.tone);
  return toneOf(iconTone[props.name] ?? "ink");
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
  const color = () => resolveIconColor(props);

  return (
    <Canvas
      testID={props.testID}
      accessible={props.label !== undefined}
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      class="shrink-0"
      style={{ width: size(), height: size() }}
      draw={(cx) => drawIconShapes(cx, ICON_PATHS[props.name], size(), color(), cachedPath)}
    />
  );
}
