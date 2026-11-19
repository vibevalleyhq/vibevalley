// Ported from VibeValley apps/web/src/ui/IconButton.tsx.
import { Text, View } from "nsh";

import { hostApi } from "../../../bridge";
import { Link as A } from "../infra/router";
import { Icon, type IconSize } from "./Icon";
import type { IconName } from "./icons";
import { Bubble } from "./Tip";

/** A button that is only its icon: its label is what hovering shows and what a screen reader says. */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  size?: IconSize;
  tone?: "danger" | undefined;
  pressed?: boolean;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={props.label}
      accessibilityState={props.pressed === undefined ? undefined : { selected: props.pressed }}
      disabled={props.disabled}
      tooltip={<Bubble text={props.label} />}
      onPress={() => props.onClick()}
      class={[
        "size-7 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-selected active:translate-y-px",
        props.pressed === true ? "bg-selected" : "",
        props.disabled === true ? "opacity-50" : "",
      ].join(" ")}
    >
      <Icon name={props.icon} size={props.size ?? 16} tone={props.tone === "danger" ? "berry" : "muted"} />
    </View>
  );
}

/** A link out to another site that says where it goes: beside a field, where an icon alone would not. */
export function OutLink(props: { href: string; label: string }) {
  return (
    <View role="link" onPress={() => void hostApi.openUrl(props.href)} class="shrink-0 flex-row items-center gap-1 rounded-sm">
      <Text class="text-xs text-muted">{props.label}</Text>
      <Icon name="open" size={12} tone="muted" />
    </View>
  );
}

/** A link that is only its icon, to a page of the workbench. */
export function IconLink(props: { href: `/${string}`; label: string; icon?: IconName }) {
  return (
    <A
      href={props.href}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} />}
      class="size-7 items-center justify-center rounded-md hover:bg-selected"
    >
      <Icon name={props.icon ?? "open"} size={16} tone="muted" />
    </A>
  );
}
