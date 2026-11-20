// Ported from VibeValley apps/web/src/ui/Tip.tsx: base-ui's Tooltip becomes
// nsh/base's (an element's `tooltip`), the same bubble and delay.
import { Text, View, type JSX } from "nsh";
import { Tooltip, type Placement } from "nsh/base";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { mix } from "./tone";

const delay = 300;

export function Bubble(props: { text: string; placement?: Placement | undefined }) {
  return (
    <Tooltip
      delay={delay}
      offset={6}
      margin={8}
      placement={props.placement}
      class="max-w-72 rounded-md border bg-ink px-2.5 py-1.5 shadow-float transition duration-120 ease-out"
      style={{ borderColor: mix("page", 0.14) }}
      startingClass="opacity-0"
      endingClass="opacity-0"
    >
      <Text class="min-w-0 text-xs leading-snug text-page">{props.text}</Text>
    </Tooltip>
  );
}

export function Tip(props: { text: string; placement?: Placement | undefined; children: JSX.Element }) {
  return <View tooltip={<Bubble text={props.text} placement={props.placement} />}>{props.children}</View>;
}

/** An info icon that says `text` on hover or focus; it describes, it does not label (a field's label stays its own). */
/** icon: info for what a thing is; another for a fact of another kind beside it (where the settings are kept). */
export function Hint(props: { text: string; icon?: IconName; placement?: Placement | undefined }) {
  return (
    <View
      focusable
      accessibilityLabel={props.text}
      tooltip={<Bubble text={props.text} placement={props.placement} />}
      // A form of ten fields should not read as ten marks: help stays out of the way.
      class="size-4 shrink-0 items-center justify-center rounded-sm opacity-60 transition duration-120 ease-out hover:bg-hover hover:opacity-100 focus:bg-hover focus:opacity-100"
    >
      <Icon name={props.icon ?? "info"} size={12} tone="faint" />
    </View>
  );
}
