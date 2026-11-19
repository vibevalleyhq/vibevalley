// Ported from VibeValley apps/web/src/ui/Tip.tsx: base-ui's Tooltip becomes
// nsh/base's (an element's `tooltip`), the same bubble and delay.
import { Text, View, type JSX } from "nsh";
import { Tooltip } from "nsh/base";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

const delay = 300;

export function Bubble(props: { text: string }) {
  return (
    <Tooltip delay={delay} offset={6} class="max-w-72 rounded-md bg-ink px-2 py-1 shadow-float">
      <Text class="text-xs leading-snug text-page">{props.text}</Text>
    </Tooltip>
  );
}

export function Tip(props: { text: string; children: JSX.Element }) {
  return <View tooltip={<Bubble text={props.text} />}>{props.children}</View>;
}

/** An info icon that says `text` on hover or focus; it describes, it does not label (a field's label stays its own). */
/** icon: info for what a thing is; another for a fact of another kind beside it (where the settings are kept). */
export function Hint(props: { text: string; icon?: IconName }) {
  return (
    <View
      focusable
      accessibilityLabel={props.text}
      tooltip={<Bubble text={props.text} />}
      // A form of ten fields should not read as ten marks: help stays out of the way.
      class="rounded-sm opacity-50 hover:opacity-100 focus:opacity-100"
    >
      <Icon name={props.icon ?? "info"} size={12} tone="faint" />
    </View>
  );
}
