import { Canvas, colorScheme, Path2D } from "nsh";

import { resolveIconColorHex } from "@vibevalley/protocol/ui";

import { useDesignHost } from "./host";
import { createIconPathCache, drawIconShapes, ICON_PATHS } from "./iconPaths.gen";
import type { IconName } from "./icons";
import { tone as toneOf } from "./tone";

// The size ladder (docs/design/01-philosophy-and-tokens.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

const cachedPath = createIconPathCache((d) => new Path2D(d));

/** Resolves an icon's hex color: explicit `color`, explicit `tone`, status fallback, or `"ink"`. */
export function resolveIconColor(props: { name: IconName; color?: string; tone?: string }): string {
  // Read colorScheme so theme switches push the updated hex token into VvIcon and Canvas draws.
  colorScheme();
  return resolveIconColorHex(props, toneOf);
}

export function Icon(props: { name: IconName; size?: number; label?: string; color?: string; tone?: string; testID?: string }) {
  const host = useDesignHost();
  const size = () => props.size ?? 16;
  const color = () => resolveIconColor(props);
  const VvIcon = host.rich()?.VvIcon;
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
      draw={(cx) => drawIconShapes(cx, ICON_PATHS[props.name], size(), color(), cachedPath)}
    />
  );
}
