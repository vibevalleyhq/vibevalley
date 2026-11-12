import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { Tabs as Base } from "@vibevalley/base-ui";

import { Link as A } from "#/infra/router.ts";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { withStyles } from "./positioner";

interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName | undefined;
  /** The tab is a link: selecting it goes there (the selection then follows the address). */
  readonly href?: string;
}

export type TabsLook = "pills" | "line";

// A line tab is the group its icon reads: the icon is full only on the tab under the pointer or selected.
const looks: Record<TabsLook, { list: string; tab: string }> = {
  pills: {
    list: "flex flex-wrap gap-0.5",
    tab: "h-7 rounded-md px-2.5 hover:bg-hover data-selected:bg-selected",
  },
  line: {
    list: "flex gap-1",
    tab: "group/tab -mb-px border-b-2 border-transparent px-2 pt-2 pb-1.5 data-selected:border-ink",
  },
};

export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  onChange?: (v: T) => void;
  items: readonly TabItem<T>[];
  look?: TabsLook;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
}) {
  return (
    <Base.Root
      value={props.value}
      onValueChange={(v) => {
        const item = props.items.find((i) => i.value === v);
        if (item) props.onChange?.(item.value);
      }}
    >
      <Base.List aria-label={props.label} {...withStyles(props.styles, [looks[props.look ?? "pills"].list, props.class])}>
        <For each={props.items}>
          {(item) => (
            <Base.Tab
              value={item.value}
              data-key={item.value}
              render={item.href === undefined ? undefined : (p) => <A {...p} href={item.href ?? ""} />}
              class={[
                "flex cursor-pointer items-center gap-1.5 text-sm text-muted hover:text-ink data-selected:font-semibold data-selected:text-ink",
                looks[props.look ?? "pills"].tab,
              ]}
            >
              <Show when={item.icon}>
                {(icon) => (
                  <Icon
                    name={icon()}
                    size={props.look === "line" ? 16 : 14}
                    class="opacity-70 group-hover/tab:opacity-100 group-data-selected/tab:opacity-100"
                  />
                )}
              </Show>
              {item.label}
            </Base.Tab>
          )}
        </For>
      </Base.List>
    </Base.Root>
  );
}
