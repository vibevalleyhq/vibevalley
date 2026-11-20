// Ported from VibeValley apps/web/src/ui/Segmented.tsx. The taken choice
// sits on the page colour as there; VibeValley slides one thumb between
// choices, here the thumb is the taken choice's own background (no slide).
import { Text, View } from "nsh";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Bubble } from "./Tip";

/** Two to five choices, one of them taken. */
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; icon?: IconName | undefined; disabled?: boolean | undefined; title?: string | undefined }[];
  onChange: (v: T) => void;
  label: string;
  block?: boolean;
  testid?: string;
}) {
  return (
    <View
      role="radiogroup"
      accessibilityLabel={props.label}
      testID={props.testid}
      class={`flex-row flex-wrap gap-0.5 rounded-md bg-hover p-0.5 ${props.block === true ? "w-full" : "self-start"}`}
    >
      <Each of={props.options}>
        {(o) => {
          const on = () => o().value === props.value;
          const disabled = () => o().disabled === true;
          const title = () => o().title;
          return (
            <View
              role="radio"
              testID={props.testid ? `${props.testid}-${o().value}` : undefined}
              accessibilityLabel={o().label}
              accessibilityState={{ selected: on(), disabled: disabled() }}
              tooltip={title() !== undefined ? <Bubble text={title() ?? ""} /> : undefined}
              disabled={o().disabled}
              onPress={() => props.onChange(o().value)}
              class={[
                "group h-6 flex-row items-center justify-center gap-1.5 rounded-sm border px-2.5 transition duration-120 ease-out",
                props.block === true ? "min-w-0 flex-1" : "",
                on() ? "border-line bg-page shadow-raise" : disabled() ? "border-transparent" : "border-transparent hover:bg-hover",
                disabled() ? "opacity-50" : "focus-visible:outline-2 focus-visible:outline-focus",
              ].join(" ")}
            >
              <If when={o().icon}>{(name) => <Icon name={name()} size={14} tone={on() ? "ink" : "muted"} />}</If>
              <Text class={`min-w-0 truncate text-sm ${on() ? "font-medium text-ink" : disabled() ? "text-muted" : "text-muted group-hover:text-ink"}`}>
                {o().label}
              </Text>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
