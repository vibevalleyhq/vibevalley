import { Text, View } from "nsh";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Bubble } from "./Tip";

type SegmentedCountTone = "muted" | "water" | "wheat";

function countToneClass(tone: SegmentedCountTone, active: boolean): string {
  switch (tone) {
    case "muted":
      return active ? "text-muted" : "text-faint";
    case "water":
      return "text-water";
    case "wheat":
      return "text-warn-ink";
  }
}

/** Two to five choices, one of them taken. */
export function Segmented<T extends string>(props: {
  value: T;
  options: {
    value: T;
    label: string;
    icon?: IconName | undefined;
    count?: number | undefined;
    countTone?: SegmentedCountTone | undefined;
    disabled?: boolean | undefined;
    title?: string | undefined;
  }[];
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
      class={`flex-row flex-wrap gap-0.5 rounded-md border border-line bg-side p-0.5 ${props.block === true ? "w-full" : "self-start"}`}
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
                on() ? "border-line bg-elevated shadow-raise" : disabled() ? "border-transparent" : "border-transparent hover:bg-hover",
                disabled() ? "opacity-50" : "focus-visible:outline-2 focus-visible:outline-focus",
              ].join(" ")}
            >
              <If when={o().icon}>{(name) => <Icon name={name()} size={14} tone={on() ? "ink" : "muted"} />}</If>
              <Text class={`min-w-0 truncate text-sm font-medium ${on() ? "text-ink" : disabled() ? "text-muted" : "text-muted group-hover:text-ink"}`}>
                {o().label}
              </Text>
              <If when={o().count !== undefined}>
                <Text class={`text-2xs tabular-nums ${countToneClass(o().countTone ?? "muted", on())}`}>{String(o().count ?? 0)}</Text>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
