import type { JSX } from "@solidjs/web";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

/** What a tag says by its colour: done or new (ok), failed (bad), sent or stopped (wait). Its ink comes with it, so it
 * reads in both themes. */
export type TagTone = "ok" | "bad" | "wait";

const tagTones: Record<TagTone, string> = { ok: "bg-ok-soft text-ok-ink", bad: "bg-bad-soft text-berry", wait: "bg-wheat/25 text-ink" };

export function Tag(props: { icon?: IconName | undefined; label: string; tone: TagTone }) {
  return (
    <span class={["inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-xs font-medium", tagTones[props.tone]]}>
      {props.icon && <Icon name={props.icon} size={12} />}
      {props.label}
    </span>
  );
}

/** What a dot says (docs/style/design.md). */
export type DotTone = "leaf" | "wheat" | "berry" | "water" | "idle" | "faint" | "muted";

const dotColor: Record<DotTone, string> = {
  leaf: "bg-leaf",
  wheat: "bg-wheat",
  berry: "bg-berry",
  water: "bg-water",
  idle: "bg-idle",
  faint: "bg-faint",
  muted: "bg-muted",
};

/** A round status dot. ring: drawn on a face or a picture, it is ringed in the page colour to stand off it. */
export function Dot(props: { tone: DotTone; size?: number; ring?: boolean; class?: JSX.ClassValue | undefined }) {
  const size = () => `${props.size ?? 9}px`;
  return (
    <span
      class={["inline-block shrink-0 rounded-full", dotColor[props.tone], props.ring !== false && "ring-2 ring-page", props.class]}
      style={{
        width: size(),
        height: size(),
      }}
      aria-hidden="true"
    />
  );
}
