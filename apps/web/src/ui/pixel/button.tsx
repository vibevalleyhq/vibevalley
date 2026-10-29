import { omit, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cx, pxDrop, pxFocus, pxText } from "./style";
import { SpriteIcon } from "./icons";

export type PxTone = "plain" | "primary" | "danger" | "accent";
export type PxSize = "md" | "sm" | "icon" | "custom";

const tones: Record<PxTone, string> = {
  plain: "bg-cream-50 enabled:hover:bg-cream-hover text-bark-900",
  // Bark on leaf, as accent is bark on wheat: cream on leaf reads at 2.5:1, under WCAG AA.
  primary: "bg-leaf-500 enabled:hover:bg-leaf-hover text-bark-900",
  // berry at 95 %.
  danger: "bg-berry enabled:hover:bg-berry-hover text-cream-50",
  accent: "bg-wheat enabled:hover:bg-wheat-hover text-bark-900",
};

const sizes: Record<PxSize, string> = {
  md: "h-9 px-4",
  sm: "h-7 px-2",
  icon: "size-9",
  custom: "",
};

/** Disabled without `onClick`. `label` names an icon button; `title` is its tooltip. `icon` goes before the words at 14 px. */
export function PxButton(
  props: {
    children?: JSX.Element;
    tone?: PxTone;
    size?: PxSize;
    icon?: string | undefined;
    label?: string;
    onClick?: ((e: MouseEvent) => void) | undefined;
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "onClick">,
) {
  const rest = omit(props, "children", "tone", "size", "icon", "label", "onClick", "disabled", "class", "type");
  // An icon alone is not framed: it sits inside a frame already (a window, a field, a card), and a ring per icon is a box
  // in a box. Hover and press show it can be tapped; the focus outline stays.
  const bare = () => (props.size ?? "md") === "icon" && (props.tone ?? "plain") === "plain";
  return (
    <button
      type={props.type ?? "button"}
      {...rest}
      onClick={(e) => props.onClick?.(e)}
      disabled={props.disabled || !props.onClick}
      aria-label={props.label}
      class={[
        pxText.sm,
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap select-none",
        pxFocus,
        "disabled:cursor-default disabled:opacity-45",
        sizes[props.size ?? "md"],
        bare()
          ? "text-bark-900 enabled:hover:bg-cream-200 enabled:active:bg-cream-300"
          : cx(
              tones[props.tone ?? "plain"],
              "border-2 border-bark-500",
              pxDrop,
              "enabled:active:translate-x-[2px] enabled:active:translate-y-[2px] enabled:active:shadow-none",
            ),
        props.class,
      ]}
    >
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={14} />}</Show>
      {props.children}
    </button>
  );
}
