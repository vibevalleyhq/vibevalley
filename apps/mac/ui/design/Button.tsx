// nsh's text styles do not come down from a View, so the words are a Text of their own in the tone's ink.
import { Text, View, type JSX } from "nsh";

import { followDesignHref, useDesignHost } from "./host";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { motionClass } from "./motion";
import { mix, tone as toneColor } from "./tone";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const resting: Record<Tone, string> = {
  plain: "border-line bg-page",
  primary: "border-accent bg-accent",
  quiet: "border-transparent bg-transparent",
  danger: "bg-page",
};
const interactive: Record<Tone, string> = {
  plain: "hover:border-faint hover:bg-hover",
  primary: "hover:border-accent-hover hover:bg-accent-hover",
  quiet: "hover:bg-hover",
  danger: "",
};
type Ink = "ink" | "page" | "berry";
const inks: Record<Tone, Ink> = { plain: "ink", primary: "page", quiet: "ink", danger: "berry" };
// Whole class names, so nsh's Tailwind reads them (it cannot read `text-${ink}`).
const inkClass: Record<Ink, string> = { ink: "text-ink", page: "text-page", berry: "text-berry" };

/** Words or other children: a string becomes a Text in `ink`'s color and `size`. */
export function Words(props: { children?: JSX.Element; ink?: Ink; class?: string }) {
  return (
    <If when={typeof props.children === "string" || typeof props.children === "number"} else={props.children}>
      <Text class={`min-w-0 truncate ${props.class ?? "text-sm"} ${inkClass[props.ink ?? "ink"]}`}>{props.children}</Text>
    </If>
  );
}

function buttonClass(tone: Tone, compact: boolean, disabled: boolean, extra?: string) {
  return [
    `flex-row items-center justify-center gap-1.5 rounded-md border ${motionClass("transition-transform duration-120 ease-out")}`,
    compact ? "h-6 px-2" : "h-7 px-2.5",
    resting[tone],
    disabled ? "opacity-50" : `${interactive[tone]} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`,
    extra ?? "",
  ].join(" ");
}

function ButtonContent(props: { tone: Tone; compact: boolean; icon?: IconName | undefined; children?: JSX.Element }) {
  const wordClass = () => {
    const base = props.compact ? "text-xs" : "text-sm";
    return props.tone === "primary" ? `${base} font-medium` : base;
  };
  return (
    <>
      <If when={props.icon}>{(name) => <Icon name={name()} size={props.compact ? 12 : 14} tone={inks[props.tone]} />}</If>
      <Words ink={inks[props.tone]} class={wordClass()}>
        {props.children}
      </Words>
    </>
  );
}

export function Button(props: {
  tone?: Tone;
  size?: "compact" | "control" | undefined;
  icon?: IconName | undefined;
  children?: JSX.Element;
  class?: string | undefined;
  onPress?: () => void;
  disabled?: boolean | undefined;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
  tooltip?: JSX.Element | undefined;
}) {
  const tone = () => props.tone ?? "plain";
  const compact = () => props.size === "compact";
  const disabled = () => props.disabled === true;
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      tooltip={props.tooltip}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class={buttonClass(tone(), compact(), disabled(), props.class)}
      style={tone() === "danger" ? { borderColor: mix("berry", 0.35) } : undefined}
      hoverStyle={!disabled() && tone() === "danger" ? { borderColor: toneColor("berry"), backgroundColor: toneColor("bad-soft") } : undefined}
    >
      <ButtonContent tone={tone()} compact={compact()} icon={props.icon}>
        {props.children}
      </ButtonContent>
    </View>
  );
}

export function ButtonLink(props: {
  href: string;
  tone?: Tone;
  size?: "compact" | "control" | undefined;
  icon?: IconName | undefined;
  children?: JSX.Element;
  class?: string | undefined;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
  tooltip?: JSX.Element | undefined;
}) {
  const designHost = useDesignHost();
  const tone = () => props.tone ?? "plain";
  const compact = () => props.size === "compact";
  return (
    <View
      role="link"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      tooltip={props.tooltip}
      onPress={() => followDesignHref(designHost, props.href)}
      class={buttonClass(tone(), compact(), false, props.class)}
      style={tone() === "danger" ? { borderColor: mix("berry", 0.35) } : undefined}
      hoverStyle={tone() === "danger" ? { borderColor: toneColor("berry"), backgroundColor: toneColor("bad-soft") } : undefined}
    >
      <ButtonContent tone={tone()} compact={compact()} icon={props.icon}>
        {props.children}
      </ButtonContent>
    </View>
  );
}
