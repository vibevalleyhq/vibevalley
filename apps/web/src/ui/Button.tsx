import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const tones: Record<Tone, string> = {
  plain: "border border-line bg-page hover:bg-hover",
  primary: "border border-accent bg-accent text-page hover:bg-leaf",
  quiet: "border border-transparent hover:bg-hover",
  danger: "border border-line bg-page text-berry hover:bg-hover",
};

export function Button(props: { tone?: Tone; icon?: IconName; children?: JSX.Element } & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const rest = omit(props, "tone", "icon", "children", "class");
  return (
    <button
      type="button"
      {...rest}
      class={[
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap disabled:cursor-default disabled:opacity-50",
        tones[props.tone ?? "plain"],
        props.class,
      ]}
    >
      {props.icon && <Icon name={props.icon} size={14} />}
      {props.children}
    </button>
  );
}
