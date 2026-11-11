import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { omit } from "solid-js";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { styleProps } from "./positioner";
import { colors, durations, easing, leading, media, radii, text } from "./tokens.stylex";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const styles = stylex.create({
  button: {
    display: "inline-flex",
    height: "1.75rem",
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.md,
    paddingInline: "0.625rem",
    fontSize: text.sm,
    lineHeight: leading.sm,
    whiteSpace: "nowrap",
    transitionProperty: "background-color, border-color, translate",
    transitionTimingFunction: easing.out,
    transitionDuration: durations.pointer,
    translate: { default: null, ":active": { default: "0 1px", ":disabled": "0 0" } },
    opacity: { default: null, ":disabled": 0.5 },
  },
  plain: {
    borderColor: colors.line,
    backgroundColor: { default: colors.page, [media.hover]: { default: null, ":hover": colors.hover } },
  },
  primary: {
    borderColor: colors.accent,
    backgroundColor: { default: colors.accent, [media.hover]: { default: null, ":hover": colors.accentHover } },
    color: colors.page,
  },
  quiet: {
    borderColor: "transparent",
    backgroundColor: { default: "transparent", [media.hover]: { default: null, ":hover": colors.hover } },
  },
  danger: {
    borderColor: colors.line,
    backgroundColor: { default: colors.page, [media.hover]: { default: null, ":hover": colors.hover } },
    color: colors.berry,
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
