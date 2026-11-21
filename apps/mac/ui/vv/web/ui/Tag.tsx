// Ported from VibeValley apps/web/src/ui/Tag.tsx.
import { Text, View } from "nsh";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { mix } from "./tone";

/** What a tag says by its colour: done or new (ok), failed (bad), sent or stopped (wait). Its ink comes with it, so it
 * reads in both themes. */
export type TagTone = "ok" | "bad" | "wait";

// Whole class names, so nsh's Tailwind reads every surface and text token cleanly in both themes.
const tagTones: Record<TagTone, { bgClass: string; bgStyle?: () => string; textClass: string; iconTone: string }> = {
  ok: { bgClass: "bg-ok-soft", textClass: "text-ok-ink", iconTone: "ok-ink" },
  bad: { bgClass: "bg-bad-soft", textClass: "text-berry", iconTone: "berry" },
  wait: { bgClass: "", bgStyle: () => mix("wheat", 0.22), textClass: "text-warn-ink", iconTone: "warn-ink" },
};

export function Tag(props: { icon?: IconName | undefined; label: string; tone: TagTone }) {
  const look = () => tagTones[props.tone];
  const bgStyle = () => {
    const bg = look().bgStyle;
    return bg ? { backgroundColor: bg() } : undefined;
  };
  return (
    <View class={`h-5 flex-row items-center gap-1 self-start rounded-sm px-1.5 ${look().bgClass}`} style={bgStyle()}>
      <If when={props.icon}>{(name) => <Icon name={name()} size={12} tone={look().iconTone} />}</If>
      <Text class={`text-xs font-medium ${look().textClass}`}>{props.label}</Text>
    </View>
  );
}

/** What a dot says (docs/design/02-atomic-components.md). */
export type DotTone = "leaf" | "wheat" | "berry" | "water" | "idle" | "faint" | "muted";

const dotBg: Record<DotTone, string> = {
  leaf: "bg-leaf",
  wheat: "bg-wheat",
  berry: "bg-berry",
  water: "bg-water",
  idle: "bg-idle",
  faint: "bg-faint",
  muted: "bg-muted",
};

/** A round status dot. ring: drawn on a face or a picture, it is ringed in the page colour to stand off it. */
export function Dot(props: { tone: DotTone; size?: number; ring?: boolean; class?: string }) {
  const size = () => props.size ?? 9;
  return (
    <View
      class={`shrink-0 rounded-full ${dotBg[props.tone]} ${props.ring !== false ? "border-2 border-page" : ""} ${props.class ?? ""}`}
      style={{ width: size() + (props.ring !== false ? 4 : 0), height: size() + (props.ring !== false ? 4 : 0) }}
    />
  );
}
