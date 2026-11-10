import * as stylex from "@stylexjs/stylex";
import { type ComponentProps, For, Show } from "solid-js";

import { Menu } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { positionerAttrs } from "./positioner";

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    flexShrink: 0,
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--color-muted)",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" },
      ":is([data-popup-open])": "var(--color-ink)",
    },
    backgroundColor: {
      default: null,
      "@media (hover: hover)": { default: null, ":hover": "var(--color-selected)" },
      ":is([data-popup-open])": "var(--color-selected)",
    },
    transitionProperty: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--default-transition-timing-function)",
  },
  popup: {
    display: "flex",
    minWidth: "calc(var(--spacing) * 44)",
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    flexDirection: "column",
    borderRadius: "var(--radius-lg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "var(--spacing)",
    boxShadow: "var(--shadow-float)",
    outlineStyle: "none",
  },
  above: { transformOrigin: "bottom right" },
  below: { transformOrigin: "top right" },
  separator: { marginBlock: "var(--spacing)", height: 1, backgroundColor: "var(--color-line)" },
  item: {
    display: "flex",
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    backgroundColor: { default: null, ":is([data-highlighted])": "var(--color-hover)" },
  },
  danger: { color: "var(--color-berry)" },
  icon: { color: "var(--color-muted)" },
});

export interface MoreItem {
  /** Its data-key: what a test or a style finds it by. */
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  /** A danger item is the last and in berry: what it does is not easily taken back. */
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

/** ⋯: the actions a place has that are not its main one, in base-ui's Menu, drawn like every workbench menu. */
export function MoreMenu(props: {
  label: string;
  /** The trigger's picture: ⋯ unless the menu is one choice of a kind (send to which channel). */
  icon?: IconName;
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
        {...stylex.attrs(styles.trigger)}
      >
        <Icon name={props.icon ?? "more"} size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner {...positionerAttrs()} side={props.side ?? "bottom"} align="end">
          <Menu.Popup aria-label={props.label} {...stylex.attrs(styles.popup, props.side === "top" ? styles.above : styles.below)}>
            <For each={props.items}>
              {(item) => (
                <>
                  <Show when={item.danger}>
                    <Menu.Separator {...stylex.attrs(styles.separator)} />
                  </Show>
                  <Menu.Item data-key={item.key} onClick={() => item.onSelect()} {...stylex.attrs(styles.item, item.danger === true && styles.danger)}>
                    <Show when={item.icon}>{(icon) => <Icon name={icon()} size={14} styles={item.danger !== true && styles.icon} />}</Show>
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
