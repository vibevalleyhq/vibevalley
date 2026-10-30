import { Menu } from "@vibevalley/base-ui";
import { type ComponentProps, For, Show } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export interface MoreItem {
  /** Its data-key: what a test or a style finds it by. */
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  /** A danger item is the last and in berry: what it does is not easily taken back. */
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

/** ⋯: the actions a place has that are not its main one, in base-ui's Menu, drawn like every workbench menu. open and
 * onOpenChange when the place shows something while it is open (a toolbar that stays); render makes the trigger part of
 * a toolbar (Toolbar.Button). */
export function MoreMenu(props: {
  label: string;
  items: readonly MoreItem[];
  testid?: string;
  /** The trigger's data-key, where its testid names a kind of button (a message's tools). */
  dataKey?: string;
  side?: "top" | "bottom";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  render?: ComponentProps<typeof Menu.Trigger>["render"];
}) {
  return (
    <Menu.Root open={props.open} onOpenChange={(open) => props.onOpenChange?.(open)}>
      <Menu.Trigger
        render={props.render}
        data-testid={props.testid}
        data-key={props.dataKey}
        aria-label={props.label}
        title={props.label}
        class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-120 hover:bg-selected hover:text-ink data-popup-open:bg-selected data-popup-open:text-ink"
      >
        <Icon name="more" size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={props.side ?? "bottom"} align="end" class="z-30">
          <Menu.Popup
            aria-label={props.label}
            class={[
              "flex min-w-44 animate-pop-in flex-col rounded-lg border border-line bg-page p-1 shadow-float outline-none",
              props.side === "top" ? "origin-bottom-right" : "origin-top-right",
            ]}
          >
            <For each={props.items}>
              {(item) => (
                <>
                  <Show when={item.danger}>
                    <Menu.Separator class="my-1 h-px bg-line" />
                  </Show>
                  <Menu.Item
                    data-key={item.key}
                    onClick={() => item.onSelect()}
                    class={[
                      "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none data-highlighted:bg-hover",
                      item.danger === true ? "text-berry" : "",
                    ]}
                  >
                    <Show when={item.icon}>{(icon) => <Icon name={icon()} size={14} class={item.danger === true ? "" : "text-muted"} />}</Show>
                    {item.label}
                  </Menu.Item>
                </>
              )}
            </For>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
