// Ported from VibeValley apps/web/src/ui/Tabs.tsx: the same two looks; a
// tab with an href goes there (the selection then follows the address).
import { Text, View } from "nsh";

import { useRouter } from "../infra/router";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName | undefined;
  readonly href?: string;
}

export type TabsLook = "pills" | "line";

const looks: Record<TabsLook, { list: string; tab: (on: boolean) => string }> = {
  pills: { list: "flex-row flex-wrap gap-0.5", tab: (on) => `h-7 rounded-md px-2.5 ${on ? "bg-selected" : "hover:bg-hover"}` },
  line: { list: "flex-row gap-1", tab: (on) => `-mb-px h-8 border-b-2 px-2.5 ${on ? "border-ink" : "border-transparent hover:border-line"}` },
};

export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  onChange?: (v: T) => void;
  items: readonly TabItem<T>[];
  look?: TabsLook;
  class?: string | undefined;
}) {
  const router = useRouter();
  const look = () => looks[props.look ?? "pills"];
  return (
    <View role="tablist" accessibilityLabel={props.label} class={`${look().list} ${props.class ?? ""}`}>
      <Each of={props.items}>
        {(item) => {
          const on = () => item().value === props.value;
          return (
            <View
              role="tab"
              testID={`tab-${item().value}`}
              accessibilityState={{ selected: on() }}
              onPress={() => {
                const href = item().href;
                if (href !== undefined) router.navigate(href);
                props.onChange?.(item().value);
              }}
              class={`group flex-row items-center gap-1.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${look().tab(on())}`}
            >
              <If when={item().icon}>{(icon) => <Icon name={icon()} size={props.look === "line" ? 16 : 14} tone={on() ? "ink" : "muted"} />}</If>
              <Text class={`text-sm font-medium ${on() ? "text-ink" : "text-muted group-hover:text-ink"}`}>{item().label}</Text>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
