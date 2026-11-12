import type { JSX } from "@solidjs/web";

import { type IconName, icons } from "./icons";

// The size ladder (docs/style/design.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

/** The marks keep their colour wherever they stand, over a caller's colour too: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, string>> = { check: "text-leaf!", cross: "text-berry!", warn: "text-wheat!" };

export function Icon(props: { name: IconName; size?: IconSize; label?: string; class?: JSX.ClassValue | undefined }) {
  return (
    <span
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      class={["inline-flex shrink-0", props.class, iconTone[props.name]]}
    >
      {icons[props.name]({ size: props.size ?? 16, attrs: { "aria-hidden": "true", focusable: "false" } })}
    </span>
  );
}
