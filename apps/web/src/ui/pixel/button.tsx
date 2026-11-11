import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { omit, Show } from "solid-js";

import { styleProps } from "#/ui/positioner.ts";

import { SpriteIcon } from "./icons";
import { pxStyle } from "./style";

export type PxTone = "plain" | "primary" | "danger" | "accent";
export type PxSize = "md" | "sm" | "icon" | "custom";

const styles = stylex.create({
  button: {
    display: "inline-flex",
    flexShrink: 0,
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    justifyContent: "center",
    gap: "0.375rem",
    whiteSpace: "nowrap",
    userSelect: "none",
    opacity: { default: null, ":disabled": 0.45 },
  },
  plain: {
    backgroundColor: { default: "var(--color-cream-50)", "@media (hover:hover)": { default: null, ":enabled:hover": "var(--color-cream-hover)" } },
    color: "var(--color-bark-900)",
  },
  primary: {
    backgroundColor: { default: "var(--color-leaf-500)", "@media (hover:hover)": { default: null, ":enabled:hover": "var(--color-leaf-hover)" } },
    color: "var(--color-bark-900)",
  },
  danger: {
    backgroundColor: { default: "var(--color-berry)", "@media (hover:hover)": { default: null, ":enabled:hover": "var(--color-berry-hover)" } },
    color: "var(--color-cream-50)",
  },
  accent: {
    backgroundColor: { default: "var(--color-wheat)", "@media (hover:hover)": { default: null, ":enabled:hover": "var(--color-wheat-hover)" } },
    color: "var(--color-bark-900)",
  },
  bare: {
    color: "var(--color-bark-900)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": { default: null, ":enabled:hover": "var(--color-cream-200)" },
      ":enabled:active": "var(--color-cream-300)",
    },
  },
  framed: {
    borderStyle: "solid",
    borderWidth: 2,
    borderColor: "var(--color-bark-500)",
    boxShadow: { default: "2px 2px 0 0 var(--color-px-drop)", ":enabled:active": "none" },
    translate: { default: null, ":enabled:active": "2px 2px" },
  },
  md: { height: "2.25rem", paddingInline: "1rem" },
  sm: { height: "1.75rem", paddingInline: "0.5rem" },
  icon: { width: "2.25rem", height: "2.25rem" },
});

const tones: Record<PxTone, stylex.StyleXStyles> = { plain: styles.plain, primary: styles.primary, danger: styles.danger, accent: styles.accent };
const sizes: Record<PxSize, stylex.StyleXStyles> = { md: styles.md, sm: styles.sm, icon: styles.icon, custom: undefined };

/** Disabled without `onClick`. `label` names an icon button. */
export function PxButton(
  props: {
    children?: JSX.Element;
    tone?: PxTone;
    size?: PxSize;
    icon?: string | undefined;
    label?: string;
    onClick?: ((e: MouseEvent) => void) | undefined;
    styles?: stylex.StyleXStyles;
    style?: JSX.CSSProperties;
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "onClick" | "class" | "style">,
) {
  const rest = omit(props, "children", "tone", "size", "icon", "label", "onClick", "disabled", "styles", "style", "type");
  // An icon alone is not framed: it sits inside a frame already (a window, a field, a card), and a ring per icon is a box in a box.
  const bare = () => (props.size ?? "md") === "icon" && (props.tone ?? "plain") === "plain";
  return (
    <button
      type={props.type ?? "button"}
      {...rest}
      onClick={(e) => props.onClick?.(e)}
      disabled={props.disabled === true || props.onClick === undefined}
      aria-label={props.label}
      {...styleProps(
        [
          pxStyle.sm,
          styles.button,
          pxStyle.focus,
          sizes[props.size ?? "md"],
          bare() ? styles.bare : [tones[props.tone ?? "plain"], styles.framed],
          props.styles,
        ],
        props.style,
      )}
    >
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={14} />}</Show>
      {props.children}
    </button>
  );
}
