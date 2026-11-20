import { Text, View } from "nsh";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

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
          return (
            <View
              role="radio"
              testID={props.testid ? `${props.testid}-${o().value}` : undefined}
              accessibilityLabel={o().label}
              accessibilityState={{ selected: on(), disabled: o().disabled === true }}
              disabled={o().disabled}
              onPress={() => props.onChange(o().value)}
              class={[
                "h-6 flex-row items-center justify-center gap-1.5 rounded-sm px-2.5",
                props.block === true ? "flex-1" : "",
                on() ? "bg-page shadow-raise" : "",
                o().disabled === true ? "opacity-50" : "",
              ].join(" ")}
            >
              <If when={o().icon}>{(name) => <Icon name={name()} size={14} tone={on() ? "ink" : "muted"} />}</If>
              <Text class={`truncate text-sm ${on() ? "font-medium text-ink" : "text-muted"}`}>{o().label}</Text>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
