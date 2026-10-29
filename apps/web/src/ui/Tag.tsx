import { Icon } from "./Icon";
import type { IconName } from "./icons";

/** What a tag says by its colour: done or new (ok), failed (bad), sent or stopped (wait). Its ink comes with it, so it
 * reads in both themes. */
export type TagTone = "ok" | "bad" | "wait";

const tagTones: Record<TagTone, string> = {
  ok: "bg-ok-soft text-ok-ink",
  bad: "bg-bad-soft text-berry",
  wait: "bg-wheat/25 text-ink",
};

export function Tag(props: { icon?: IconName | undefined; label: string; tone: TagTone }) {
  return (
    <span class={["inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-xs font-medium", tagTones[props.tone]]}>
      {props.icon && <Icon name={props.icon} size={12} />}
      {props.label}
    </span>
  );
}
