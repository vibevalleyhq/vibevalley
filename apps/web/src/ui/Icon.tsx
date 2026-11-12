import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";

import { type IconName, icons } from "./icons";
import { withStyles } from "./positioner";

// The size ladder (docs/style/design.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

/** The marks keep their colour wherever they stand, over a caller's colour too: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, string>> = { check: "text-leaf!", cross: "text-berry!", warn: "text-wheat!" };

export function Icon(props: {
  name: IconName;
  size?: IconSize;
  label?: string;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
}) {
  return (
    <span
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      {...withStyles(props.styles, ["inline-flex shrink-0", props.class, iconTone[props.name]])}
    >
      {icons[props.name]({ size: props.size ?? 16, attrs: { "aria-hidden": "true", focusable: "false" } })}
    </span>
  );
}
