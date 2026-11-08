import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { omit } from "solid-js";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { styleProps } from "./positioner";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const styles = stylex.create({
  button: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 7)",
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "nowrap",
    transitionProperty: "background-color, border-color, translate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: "120ms",
    translate: { default: null, ":active": { default: "0 1px", ":disabled": "0 0" } },
    opacity: { default: null, ":disabled": 0.5 },
  },
  plain: {
    borderColor: "var(--color-line)",
    backgroundColor: { default: "var(--color-page)", "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
  },
  primary: {
    borderColor: "var(--color-accent)",
    backgroundColor: { default: "var(--color-accent)", "@media (hover: hover)": { default: null, ":hover": "var(--color-accent-hover)" } },
    color: "var(--color-page)",
  },
  quiet: {
    borderColor: "transparent",
    backgroundColor: { default: "transparent", "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
  },
  danger: {
    borderColor: "var(--color-line)",
    backgroundColor: { default: "var(--color-page)", "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
    color: "var(--color-berry)",
  },
});

const tones: Record<Tone, stylex.StyleXStyles> = { plain: styles.plain, primary: styles.primary, quiet: styles.quiet, danger: styles.danger };

export function Button(
  props: {
    tone?: Tone;
    icon?: IconName | undefined;
    children?: JSX.Element;
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "style"> &
    (
      | { styles?: undefined; style?: JSX.ButtonHTMLAttributes<HTMLButtonElement>["style"] }
      | { styles: stylex.StyleXStyles; style?: JSX.CSSProperties | undefined }
    ),
) {
  const rest = omit(props, "tone", "icon", "children", "styles", "style");
  const appearance = () => {
    const composed = styleProps([styles.button, tones[props.tone ?? "plain"], props.styles]);
    return {
      ...composed,
      style: typeof props.style === "object" || props.style === undefined ? { ...composed.style, ...props.style } : props.style,
    };
  };
  return (
    <button type="button" {...rest} {...appearance()}>
      {props.icon && <Icon name={props.icon} size={14} />}
      {props.children}
    </button>
  );
}
