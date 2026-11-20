import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

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
  return (
    <Menu
      open={props.open}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
      placement={props.side ?? "bottom"}
      align="end"
      offset={4}
      popupClass="min-w-44 rounded-lg border border-line bg-page p-1 shadow-float"
      trigger={
        <View testID={props.testid} accessibilityLabel={props.label} class="size-7 shrink-0 items-center justify-center rounded-md hover:bg-selected">
          <Icon name={props.icon ?? "more"} size={16} tone="muted" />
        </View>
      }
    >
      <Each of={props.items}>
        {(item) => (
          <>
            <If when={item().danger}>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <MenuItem testID={`more-${item().key}`} onSelect={() => item().onSelect()} class="h-7 flex-row items-center gap-2 rounded-md px-2 focus:bg-hover">
              <If when={item().icon}>{(icon) => <Icon name={icon()} size={14} tone={item().danger === true ? "berry" : "muted"} />}</If>
              <Text class={`text-sm ${item().danger === true ? "text-berry" : "text-ink"}`}>{item().label}</Text>
            </MenuItem>
          </>
        )}
      </Each>
    </Menu>
  );
}
