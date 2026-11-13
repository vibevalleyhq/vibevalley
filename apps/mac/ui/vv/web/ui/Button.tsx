// Ported from VibeValley apps/web/src/ui/Button.tsx: the same tones and
// sizes. nsh's text styles do not come down from a View, so the words are
// a Text of their own in the tone's ink.
import { Text, View, type JSX } from "nsh";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

export type Tone = "plain" | "primary" | "quiet" | "danger";

const tones: Record<Tone, string> = {
  plain: "border-line bg-page hover:bg-hover",
  primary: "border-accent bg-accent hover:bg-accent-hover",
  quiet: "border-transparent bg-transparent hover:bg-hover",
  danger: "border-line bg-page hover:bg-hover",
};
type Ink = "ink" | "page" | "berry";
const inks: Record<Tone, Ink> = { plain: "ink", primary: "page", quiet: "ink", danger: "berry" };
// Whole class names, so nsh's Tailwind reads them (it cannot read `text-${ink}`).
const inkClass: Record<Ink, string> = { ink: "text-ink", page: "text-page", berry: "text-berry" };

/** Words or other children: a string becomes a Text in `ink`'s color and `size`. */
export function Words(props: { children?: JSX.Element; ink?: Ink; class?: string }) {
  return (
    <If when={typeof props.children === "string" || typeof props.children === "number"} else={props.children}>
      <Text class={`truncate ${props.class ?? "text-sm"} ${inkClass[props.ink ?? "ink"]}`}>{props.children as string}</Text>
    </If>
  );
}

export function Button(props: {
  tone?: Tone;
  icon?: IconName | undefined;
  children?: JSX.Element;
  class?: string | undefined;
  onPress?: () => void;
  disabled?: boolean | undefined;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const tone = () => props.tone ?? "plain";
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class={[
        // Pressed, it sinks a pixel: the press answers under the finger, at the pointer's speed.
        "h-7 flex-row items-center gap-1.5 rounded-md border px-2.5 transition duration-120 ease-out active:translate-y-px",
        tones[tone()],
        props.disabled === true ? "opacity-50" : "",
        props.class ?? "",
      ].join(" ")}
    >
      <If when={props.icon}>{(name) => <Icon name={name()} size={14} tone={inks[tone()]} />}</If>
      <Words ink={inks[tone()]}>{props.children}</Words>
    </View>
  );
}
