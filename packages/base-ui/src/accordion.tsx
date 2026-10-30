// Accordion (Base UI's): a stack of sections, each a header with a trigger and a panel it opens. One open at a time
// unless `multiple`; the arrow keys, Home and End move among the triggers. The value is the list of open items.

import type { JSX } from "@solidjs/web";
import { createContext, createUniqueId, omit, Show, useContext } from "solid-js";

import type { Orientation } from "./internal/composite";
import { createControllable } from "./internal/controllable";
import { type ButtonProps, call, type DivProps, flag, refs } from "./internal/element";
import { roveFocus } from "./internal/roving";

interface RootCtx {
  readonly open: (value: string) => boolean;
  readonly toggle: (value: string) => void;
  readonly disabled: () => boolean;
  readonly orientation: () => Orientation;
}

interface ItemCtx {
  readonly value: string;
  readonly open: () => boolean;
  readonly disabled: () => boolean;
  readonly triggerId: string;
  readonly panelId: string;
}

const RootContext = createContext<RootCtx>();
const ItemContext = createContext<ItemCtx>();

export interface AccordionRootProps extends DivProps {
  value?: readonly string[] | undefined;
  defaultValue?: readonly string[] | undefined;
  onValueChange?: ((value: string[]) => void) | undefined;
  /** Several items may be open at once. */
  multiple?: boolean | undefined;
  disabled?: boolean | undefined;
  orientation?: Orientation | undefined;
}

const trigger = "[data-accordion-trigger]:not([disabled])";

function Root(props: AccordionRootProps) {
  const rest = omit(props, "value", "defaultValue", "onValueChange", "multiple", "disabled", "orientation", "ref", "onKeyDown");
  const [value, setValue] = createControllable<readonly string[]>({
    value: () => props.value,
    initial: props.defaultValue ?? [],
    onChange: (v) => props.onValueChange?.([...v]),
  });
  let root: HTMLDivElement | undefined;
  const ctx: RootCtx = {
    open: (v) => value().includes(v),
    toggle: (v) => setValue(value().includes(v) ? value().filter((x) => x !== v) : props.multiple === true ? [...value(), v] : [v]),
    disabled: () => Boolean(props.disabled),
    orientation: () => props.orientation ?? "vertical",
  };
  return (
    <RootContext value={ctx}>
      <div
        {...rest}
        ref={refs(props.ref, (el: HTMLDivElement) => (root = el))}
        data-orientation={ctx.orientation()}
        data-disabled={flag(ctx.disabled())}
        onKeyDown={(e) => {
          call(props.onKeyDown, e);
          if (!root || e.defaultPrevented || !e.target.matches(trigger)) return;
          roveFocus(e, root, trigger, { orientation: ctx.orientation(), loop: true });
        }}
      />
    </RootContext>
  );
}

export interface AccordionItemProps extends DivProps {
  value: string;
  disabled?: boolean | undefined;
}

function Item(props: AccordionItemProps) {
  const r = useContext(RootContext);
  const rest = omit(props, "value", "disabled");
  const id = createUniqueId();
  const item: ItemCtx = {
    value: props.value,
    open: () => r.open(props.value),
    disabled: () => Boolean(props.disabled) || r.disabled(),
    triggerId: `${id}-trigger`,
    panelId: `${id}-panel`,
  };
  return (
    <ItemContext value={item}>
      <div {...rest} data-open={flag(item.open())} data-closed={flag(!item.open())} data-disabled={flag(item.disabled())} />
    </ItemContext>
  );
}

function Header(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const item = useContext(ItemContext);
  return <h3 {...props} data-open={flag(item.open())} data-closed={flag(!item.open())} />;
}

function Trigger(props: ButtonProps) {
  const r = useContext(RootContext);
  const item = useContext(ItemContext);
  const rest = omit(props, "onClick");
  return (
    <button
      type="button"
      {...rest}
      id={item.triggerId}
      disabled={item.disabled()}
      aria-expanded={item.open() ? "true" : "false"}
      aria-controls={item.open() ? item.panelId : undefined}
      data-accordion-trigger=""
      data-panel-open={flag(item.open())}
      data-disabled={flag(item.disabled())}
      onClick={(e) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) r.toggle(item.value);
      }}
    />
  );
}

function Panel(props: DivProps & { keepMounted?: boolean | undefined }) {
  const item = useContext(ItemContext);
  const rest = omit(props, "keepMounted");
  return (
    <Show when={item.open() || props.keepMounted}>
      <div
        role="region"
        {...rest}
        id={item.panelId}
        aria-labelledby={item.triggerId}
        hidden={!item.open()}
        data-open={flag(item.open())}
        data-closed={flag(!item.open())}
      />
    </Show>
  );
}

export const Accordion = { Root, Item, Header, Trigger, Panel };
