// The workbench's icons (ui/icons.ts): reicon's line drawings in the text's colour, decorative unless labelled.

import type { JSX } from "@solidjs/web";

import { type IconName, icons, iconTone } from "./icons";

// The size ladder (docs/style/design.md): 10 marks, 12 beside text-xs, 14 beside text-sm, 16 alone in a button,
// 20 in a page header or the rail, 24 for a big add tile, 48 for an empty state.
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
