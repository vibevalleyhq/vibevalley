import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Bubble } from "./Tip";

export interface MoreItem {
  /** What a test finds it by (its testID is `more-<key>`). */
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  /** A danger item is the last and in berry: what it does is not easily taken back. */
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

/** ⋯: the actions a place has that are not its main one, drawn like every workbench menu. */
export function MoreMenu(props: {
  label: string;
  /** The trigger's picture: ⋯ unless the menu is one choice of a kind (send to which channel). */
  icon?: IconName;
  items: readonly MoreItem[];
  testid?: string;
  side?: "top" | "bottom";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const hasIcons = () => props.items.some((item) => item.icon !== undefined);
  return (
    <Menu
      open={props.open}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
      placement={props.side ?? "bottom"}
      align="end"
      offset={4}
      popupClass="min-w-44 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float transition duration-120 ease-out"
      popupStartingClass="opacity-0"
      popupEndingClass="opacity-0"
      trigger={
        <View
          testID={props.testid}
          accessibilityLabel={props.label}
          tooltip={<Bubble text={props.label} />}
          class="size-7 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-hover active:translate-y-px aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name={props.icon ?? "more"} size={16} tone="muted" />
        </View>
      }
    >
      <Each of={props.items}>
        {(item, index) => (
          <>
            <If when={index() > 0 && item().danger === true && props.items[index() - 1]?.danger !== true}>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <MenuItem
              testID={`more-${item().key}`}
              onSelect={() => item().onSelect()}
              class={`h-7 flex-row items-center gap-2 rounded-md px-2 transition duration-120 ease-out ${
                item().danger === true ? "hover:bg-bad-soft focus:bg-bad-soft" : "hover:bg-hover focus:bg-hover"
              }`}
            >
              <If when={hasIcons()}>
                <View class="size-3.5 shrink-0 items-center justify-center">
                  <If when={item().icon}>{(icon) => <Icon name={icon()} size={14} tone={item().danger === true ? "berry" : "muted"} />}</If>
                </View>
              </If>
              <Text class={`min-w-0 flex-1 truncate text-sm ${item().danger === true ? "text-berry" : "text-ink"}`}>{item().label}</Text>
            </MenuItem>
          </>
        )}
      </Each>
    </Menu>
  );
}
