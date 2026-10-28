import type { JSX } from "@solidjs/web";
import { type IconName, icons, iconTone } from "./icons";

// The workbench's icons (ui/icons.ts): reicon's line drawings in the text's colour, decorative unless labelled.

export function Icon(props: { name: IconName; size?: number; label?: string; class?: JSX.ClassValue }) {
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
