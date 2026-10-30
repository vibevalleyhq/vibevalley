import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const tones: Record<Tone, string> = {
  plain: "border border-line bg-page hover:bg-hover",
  primary: "border border-accent bg-accent text-page hover:bg-accent-hover",
  quiet: "border border-transparent hover:bg-hover",
  danger: "border border-line bg-page text-berry hover:bg-hover",
};

export function Button(props: { tone?: Tone; icon?: IconName | undefined; children?: JSX.Element } & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const rest = omit(props, "tone", "icon", "children", "class");
  return (
    <button
      type="button"
      {...rest}
      class={[
        // Pressed, it sinks a pixel: the press answers under the finger, at the pointer's speed.
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap transition-[background-color,border-color,translate] duration-120 active:translate-y-px disabled:cursor-default disabled:opacity-50 disabled:active:translate-y-0",
        tones[props.tone ?? "plain"],
        props.class,
      ]}
    >
      {props.icon && <Icon name={props.icon} size={14} />}
      {props.children}
    </button>
  );
}
