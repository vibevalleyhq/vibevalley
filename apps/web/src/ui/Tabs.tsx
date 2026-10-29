import { Tabs as Base } from "@vibevalley/base-ui";
import { For, Show } from "solid-js";
import { A } from "./A";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName | undefined;
  /** The tab is a link: selecting it goes there (the selection then follows the address). */
  readonly href?: string;
}

export type TabsLook = "pills" | "line";

const looks: Record<TabsLook, { list: string; tab: string }> = {
  pills: {
    list: "flex flex-wrap gap-0.5",
    tab: "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-hover hover:text-ink data-selected:bg-selected data-selected:font-semibold data-selected:text-ink",
  },
  line: {
    list: "flex gap-1",
    tab: "group -mb-px flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-2 pt-2 pb-1.5 text-sm text-muted hover:text-ink data-selected:border-ink data-selected:font-semibold data-selected:text-ink",
  },
};

/** The panels are the page's: it shows the one for `value`. class places the list (its border, its padding). */
export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  onChange?: (v: T) => void;
  items: readonly TabItem<T>[];
  look?: TabsLook;
  class?: string | undefined;
}) {
  const look = () => looks[props.look ?? "pills"];
  return (
    <Base.Root value={props.value} onValueChange={(v) => props.onChange?.(v as T)}>
      <Base.List aria-label={props.label} class={[look().list, props.class]}>
        <For each={props.items}>
          {(item) => (
            <Base.Tab
              value={item.value}
              data-key={item.value}
              render={item.href === undefined ? undefined : (p) => <A {...p} href={item.href!} />}
              class={look().tab}
            >
              <Show when={item.icon}>
                {(icon) => (
                  <Icon name={icon()} size={props.look === "line" ? 16 : 14} class="opacity-70 group-hover:opacity-100 group-data-selected:opacity-100" />
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
