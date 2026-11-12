import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";
import { omit, Show } from "solid-js";

import { withStyles } from "#/ui/positioner.ts";

import { SpriteIcon } from "./icons";

export type PxTone = "plain" | "primary" | "danger" | "accent";
export type PxSize = "md" | "sm" | "icon" | "custom";

const tones: Record<PxTone, string> = {
  plain: "bg-cream-50 text-bark-900 enabled:hover:bg-cream-hover",
  primary: "bg-leaf-500 text-bark-900 enabled:hover:bg-leaf-hover",
  danger: "bg-berry text-cream-50 enabled:hover:bg-berry-hover",
  accent: "bg-wheat text-bark-900 enabled:hover:bg-wheat-hover",
};
const sizes: Record<PxSize, string | undefined> = { md: "h-9 px-4", sm: "h-7 px-2", icon: "h-9 w-9", custom: undefined };
// Pressed, a framed button sinks into its drop: 2 px down and right, and the drop is gone.
const framed = "border-2 border-bark-500 pixel-drop enabled:active:translate-x-0.5 enabled:active:translate-y-0.5 enabled:active:shadow-none";
const bareLook = "text-bark-900 enabled:hover:bg-cream-200 enabled:active:bg-cream-300";

/** Disabled without `onClick`. `label` names an icon button. */
export function PxButton(
  props: {
    children?: JSX.Element;
    tone?: PxTone;
    size?: PxSize;
    icon?: string | undefined;
    label?: string;
    onClick?: ((e: MouseEvent) => void) | undefined;
    class?: JSX.ClassValue | undefined;
    // For callers still on StyleX; it goes when the last of them is on classes.
    styles?: stylex.StyleXStyles;
    style?: JSX.CSSProperties;
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "onClick" | "class" | "style">,
) {
  const rest = omit(props, "children", "tone", "size", "icon", "label", "onClick", "disabled", "class", "styles", "style", "type");
  // An icon alone is not framed: it sits inside a frame already (a window, a field, a card), and a ring per icon is a box in a box.
  const bare = () => (props.size ?? "md") === "icon" && (props.tone ?? "plain") === "plain";
  return (
    <button
      type={props.type ?? "button"}
      {...rest}
      onClick={(e) => props.onClick?.(e)}
      disabled={props.disabled === true || props.onClick === undefined}
      aria-label={props.label}
      {...withStyles(
        props.styles,
        [
          "pixel-sm inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap select-none pixel-focus disabled:cursor-default disabled:opacity-45",
          sizes[props.size ?? "md"],
          bare() ? bareLook : [tones[props.tone ?? "plain"], framed],
          props.class,
        ],
        props.style,
      )}
    >
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={14} />}</Show>
      {props.children}
    </button>
  );
}
