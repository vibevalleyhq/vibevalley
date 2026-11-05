import type { JSX } from "@solidjs/web";

import { type IconName, icons, iconTone } from "./icons";

// The size ladder (docs/style/design.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

export function Icon(props: { name: IconName; size?: IconSize; label?: string; class?: JSX.ClassValue }) {
  return (
    <span
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      class={["inline-flex shrink-0", iconTone[props.name], props.class]}
    >
      {icons[props.name]({ size: props.size ?? 16 })}
    </span>
  );
}
