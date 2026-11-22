import { colorScheme, View } from "nsh";

import { richNative } from "../infra/rich";
import type { IconName } from "./icons";
import { tone as toneOf } from "./tone";

// The size ladder (docs/design/01-philosophy-and-tokens.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

/** The marks keep their colour wherever they stand, over a caller's colour too: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, string>> = { check: "leaf", cross: "berry", warn: "wheat" };

export function Icon(props: { name: IconName; size?: number; label?: string; color?: string; tone?: string; testID?: string }) {
  const size = () => props.size ?? 16;
  const color = () => {
    // Read colorScheme so theme switches push the updated hex token into VvIcon.
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
    <View
      testID={props.testID}
      accessible={props.label !== undefined}
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      class="shrink-0"
      style={{ width: size(), height: size() }}
    />
  );
}
