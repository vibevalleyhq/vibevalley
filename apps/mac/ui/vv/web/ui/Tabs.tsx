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
  line: { list: "flex-row gap-1", tab: (on) => `-mb-px border-b-2 px-2 pt-2 pb-1.5 ${on ? "border-ink" : "border-transparent"}` },
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
              class={`flex-row items-center gap-1.5 ${look().tab(on())}`}
            >
              <If when={item().icon}>
                {(icon) => (
                  <View style={{ opacity: on() ? 1 : 0.7 }}>
                    <Icon name={icon()} size={props.look === "line" ? 16 : 14} tone={on() ? "ink" : "muted"} />
                  </View>
                )}
              </If>
              <Text class={`text-sm ${on() ? "font-semibold text-ink" : "text-muted"}`}>{item().label}</Text>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
