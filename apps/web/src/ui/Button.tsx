import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";
import { omit } from "solid-js";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { withStyles } from "./positioner";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const tones: Record<Tone, string> = {
  plain: "border-line bg-page hover:bg-hover",
  primary: "border-accent bg-accent text-page hover:bg-accent-hover",
  quiet: "border-transparent bg-transparent hover:bg-hover",
  danger: "border-line bg-page text-berry hover:bg-hover",
};

export function Button(
  props: {
    tone?: Tone;
    icon?: IconName | undefined;
    children?: JSX.Element;
    class?: JSX.ClassValue | undefined;
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "style"> &
    (
      | { styles?: undefined; style?: JSX.ButtonHTMLAttributes<HTMLButtonElement>["style"] }
      // `styles` is for callers still on StyleX; it goes when the last of them is on classes.
      | { styles: stylex.StyleXStyles; style?: JSX.CSSProperties | undefined }
    ),
) {
  const rest = omit(props, "tone", "icon", "children", "class", "styles", "style");
  const appearance = () => {
    const composed = withStyles(props.styles, [
      // Pressed, it sinks a pixel: the press answers under the finger, at the pointer's speed.
      "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap transition-[background-color,border-color,translate] duration-120 ease-out active:translate-y-px disabled:cursor-default disabled:opacity-50 disabled:active:translate-y-0",
      tones[props.tone ?? "plain"],
      props.class,
    ]);
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
