// Tabs (Base UI's): a tab list and the panel of the selected tab. The list is one tab stop: arrows move along it
// (Home, End, wrapping), and Enter or Space selects, or the focus selects too with activateOnFocus. With no value given
// the first tab is selected. Tabs and panels find each other by value: tab's aria-controls, panel's aria-labelledby.

import { createContext, createSignal, createUniqueId, omit, onSettled, Show, useContext } from "solid-js";
import type { Orientation } from "./internal/composite.ts";
import { roveFocus } from "./internal/roving.ts";
import { type ButtonProps, call, createControllable, type DivProps, flag, refs } from "./internal/state.ts";

interface Ctx {
  readonly value: () => string | undefined;
  readonly select: (value: string) => void;
  readonly orientation: () => Orientation;
  readonly tabId: (value: string) => string;
  readonly panelId: (value: string) => string;
  readonly register: (value: string) => () => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface TabsRootProps extends DivProps {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  orientation?: Orientation | undefined;
}

function Root(props: TabsRootProps) {
  const rest = omit(props, "value", "defaultValue", "onValueChange", "orientation", "children");
  const [chosen, setChosen] = createControllable<string | undefined>({
    value: () => props.value,
    initial: props.defaultValue,
    onChange: (v) => v !== undefined && props.onValueChange?.(v),
  });
  const [tabs, setTabs] = createSignal<readonly string[]>([]);
  const base = createUniqueId();
  const ctx: Ctx = {
    value: () => chosen() ?? tabs()[0],
    select: setChosen,
    orientation: () => props.orientation ?? "horizontal",
    tabId: (v) => `${base}-tab-${v}`,
    panelId: (v) => `${base}-panel-${v}`,
    register: (v) => {
      setTabs((t) => [...t, v]);
      return () => setTabs((t) => t.filter((x) => x !== v));
    },
  };
  return (
    <Context value={ctx}>
      <div {...rest} data-orientation={ctx.orientation()}>
        {props.children}
      </div>
    </Context>
  );
}

export interface TabsListProps extends DivProps {
  /** Moving the focus with the arrows selects that tab too. */
  activateOnFocus?: boolean | undefined;
  /** The arrows wrap from the last tab to the first. */
  loop?: boolean | undefined;
}

function List(props: TabsListProps) {
  const c = use();
  const rest = omit(props, "activateOnFocus", "loop", "onKeyDown", "ref");
  let list: HTMLDivElement | undefined;
  return (
    <div
      role="tablist"
      {...rest}
      ref={refs(props.ref, (el: HTMLDivElement) => (list = el))}
      aria-orientation={c.orientation()}
      data-orientation={c.orientation()}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        if (!list || e.defaultPrevented) return;
        const to = roveFocus(e, list, "[role=tab]", { orientation: c.orientation(), loop: props.loop ?? true });
        if (to && props.activateOnFocus && to.dataset.value !== undefined) c.select(to.dataset.value);
      }}
    />
  );
}

export interface TabProps extends ButtonProps {
  value: string;
}

function Tab(props: TabProps) {
  const c = use();
  const rest = omit(props, "value", "onClick");
  // Registered once mounted: Solid 2 refuses a write while the component is being made.
  onSettled(() => c.register(props.value));
  const selected = () => c.value() === props.value;
  return (
    <button
      type="button"
      role="tab"
      {...rest}
      id={c.tabId(props.value)}
      data-value={props.value}
      aria-selected={selected() ? "true" : "false"}
      aria-controls={c.panelId(props.value)}
      tabindex={selected() ? 0 : -1}
      data-selected={flag(selected())}
      data-disabled={flag(Boolean(props.disabled))}
      data-orientation={c.orientation()}
      onClick={(e) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) c.select(props.value);
      }}
    />
  );
}

export interface TabsPanelProps extends DivProps {
  value: string;
  /** Kept in the page while another tab is selected, only hidden. */
  keepMounted?: boolean | undefined;
}

function Panel(props: TabsPanelProps) {
  const c = use();
  const rest = omit(props, "value", "keepMounted");
  const selected = () => c.value() === props.value;
  return (
    <Show when={selected() || props.keepMounted}>
      <div
        role="tabpanel"
        tabindex={0}
        {...rest}
        id={c.panelId(props.value)}
        aria-labelledby={c.tabId(props.value)}
        hidden={!selected()}
        data-selected={flag(selected())}
        data-orientation={c.orientation()}
      />
    </Show>
  );
}

export const Tabs = { Root, List, Tab, Panel };
