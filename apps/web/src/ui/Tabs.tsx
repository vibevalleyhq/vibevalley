import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { Tabs as Base } from "@vibevalley/base-ui";

import { Link as A } from "#/infra/router.ts";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { lineTab } from "./tabs.stylex";

interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName | undefined;
  /** The tab is a link: selecting it goes there (the selection then follows the address). */
  readonly href?: string;
}

export type TabsLook = "pills" | "line";

const styles = stylex.create({
  pillList: { display: "flex", flexWrap: "wrap", gap: "calc(var(--spacing) * 0.5)" },
  lineList: { display: "flex", gap: "var(--spacing)" },
  tab: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" },
      ":is([data-selected])": "var(--color-ink)",
    },
    fontWeight: { default: null, ":is([data-selected])": "var(--font-weight-semibold)" },
  },
  pill: {
    height: "calc(var(--spacing) * 7)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    backgroundColor: {
      default: null,
      "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" },
      ":is([data-selected])": "var(--color-selected)",
    },
  },
  line: {
    marginBottom: -1,
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderColor: { default: "transparent", ":is([data-selected])": "var(--color-ink)" },
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 2)",
    paddingBottom: "calc(var(--spacing) * 1.5)",
  },
  icon: {
    opacity: {
      default: 0.7,
      "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", lineTab)]: 1 },
      [stylex.when.ancestor("[data-selected]", lineTab)]: 1,
    },
  },
});
const looks: Record<TabsLook, { list: stylex.StyleXStyles; tab: stylex.StyleXStyles }> = {
  pills: { list: styles.pillList, tab: styles.pill },
  line: { list: styles.lineList, tab: styles.line },
};

/** The panels are the page's: it shows the one for `value`. */
export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  onChange?: (v: T) => void;
  items: readonly TabItem<T>[];
  look?: TabsLook;
  styles?: stylex.StyleXStyles;
}) {
  const list = () => stylex.props(looks[props.look ?? "pills"].list, props.styles);
  return (
    <Base.Root
      value={props.value}
      onValueChange={(v) => {
        const item = props.items.find((i) => i.value === v);
        if (item) props.onChange?.(item.value);
      }}
    >
      <Base.List aria-label={props.label} class={list().className} style={list().style}>
        <For each={props.items}>
          {(item) => (
            <Base.Tab
              value={item.value}
              data-key={item.value}
              render={item.href === undefined ? undefined : (p) => <A {...p} href={item.href ?? ""} />}
              class={[stylex.attrs(styles.tab, looks[props.look ?? "pills"].tab).class, props.look === "line" && stylex.attrs(lineTab).class]}
            >
              <Show when={item.icon}>{(icon) => <Icon name={icon()} size={props.look === "line" ? 16 : 14} class={stylex.attrs(styles.icon).class} />}</Show>
              {item.label}
            </Base.Tab>
          )}
        </For>
      </Base.List>
    </Base.Root>
  );
}
