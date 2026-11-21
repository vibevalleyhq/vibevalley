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
  const disabled = () => props.disabled === true;
  const hover = () => (props.tone === "danger" ? "hover:bg-bad-soft" : props.pressed === true ? "" : "hover:bg-hover");
  const iconTone = () => (props.tone === "danger" ? "berry" : props.pressed === true ? "ink" : "muted");
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
        "size-7 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out",
        props.pressed === true ? "bg-selected" : "",
        disabled() ? "opacity-50" : `${hover()} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`,
      ].join(" ")}
    >
      <Icon name={props.icon} size={props.size ?? 16} tone={iconTone()} />
    </View>
  );
}

/** A link out to another site that says where it goes: beside a field, where an icon alone would not. */
export function OutLink(props: { href: string; label: string }) {
  return (
    <View
      role="link"
      onPress={() => void hostApi.openUrl(props.href)}
      class="group -mx-1 shrink-0 flex-row items-center gap-1 rounded-sm px-1 py-0.5 transition duration-120 ease-out hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Text class="text-xs text-muted group-hover:text-ink">{props.label}</Text>
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
      class="size-7 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Icon name={props.icon ?? "open"} size={16} tone="muted" />
    </A>
  );
}
