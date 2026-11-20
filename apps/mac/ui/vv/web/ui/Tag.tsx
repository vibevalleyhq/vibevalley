import { Text, View } from "nsh";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { mix } from "./tone";

/** What a tag says by its colour: done or new (ok), failed (bad), sent or stopped (wait). Its ink comes with it, so it
 * reads in both themes. */
export type TagTone = "ok" | "bad" | "wait";

const tagTones: Record<TagTone, { bg: () => string; ink: string }> = {
  ok: { bg: () => mix("ok-soft", 1), ink: "ok-ink" },
  bad: { bg: () => mix("bad-soft", 1), ink: "berry" },
  wait: { bg: () => mix("wheat", 0.25), ink: "ink" },
};

export function Tag(props: { icon?: IconName | undefined; label: string; tone: TagTone }) {
  return (
    <View class="flex-row items-center gap-1 self-start rounded-sm px-1.5 py-px" style={{ backgroundColor: tagTones[props.tone].bg() }}>
      <If when={props.icon}>{(name) => <Icon name={name()} size={12} tone={tagTones[props.tone].ink} />}</If>
      <Text class={`text-xs font-medium text-${tagTones[props.tone].ink}`}>{props.label}</Text>
    </View>
  );
}

/** What a dot says (docs/style/design.md). */
export type DotTone = "leaf" | "wheat" | "berry" | "water" | "idle" | "faint" | "muted";

/** A round status dot. ring: drawn on a face or a picture, it is ringed in the page colour to stand off it. */
export function Dot(props: { tone: DotTone; size?: number; ring?: boolean; class?: string }) {
  const size = () => props.size ?? 9;
  return (
    <View
      class={`shrink-0 rounded-full bg-${props.tone} ${props.ring !== false ? "border-2 border-page" : ""} ${props.class ?? ""}`}
      style={{ width: size() + (props.ring !== false ? 4 : 0), height: size() + (props.ring !== false ? 4 : 0) }}
    />
  );
}
