// Menu (Base UI's): a list of actions under a button. Opened from the keyboard, the focus starts on the first item
// (ArrowUp: the last); opened by a click, on the menu itself. Inside, the arrows move along the items (wrapping, passing
// over disabled ones), letters jump to an item, Enter or Space or a click runs it and closes the menu. Escape, choosing
// an item and Tab give the focus back to the trigger; a press outside leaves it where the press put it.

import type { JSX } from "@solidjs/web";
import { createContext, createSignal, createUniqueId, omit, useContext } from "solid-js";
import { createDismiss } from "./internal/dismiss.ts";
import { createFloating, type Floating, type FloatingRootProps, focusWhenPlaced, makePortal, makePositioner } from "./internal/floating.tsx";
import { createTypeahead, disabled, itemsIn, roveFocus } from "./internal/roving.ts";
import { type ButtonProps, call, type DivProps, flag, openAttrs, refs } from "./internal/state.ts";

export type MenuOpenChangeReason = "trigger" | "item" | "escape" | "outside" | "tab";

const item = "[role=menuitem]";

interface Ctx extends Floating<MenuOpenChangeReason> {
  /** Where the focus goes once the menu is placed. */
  readonly start: () => "first" | "last" | "menu";
  readonly setStart: (start: "first" | "last" | "menu") => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export type MenuRootProps = FloatingRootProps<MenuOpenChangeReason>;

function Root(props: MenuRootProps) {
  const f = createFloating<MenuOpenChangeReason>(props, "trigger");
  const [start, setStart] = createSignal<"first" | "last" | "menu">("menu");
  const ctx: Ctx = {
    ...f,
    setOpen: (open, why) => {
      f.setOpen(open, why);
      if (!open && why !== "outside") f.trigger()?.focus();
    },
    start,
    setStart,
  };
  createDismiss({ open: f.open, elements: () => [f.trigger(), f.positioner()], dismiss: (why) => ctx.setOpen(false, why) });
  return <Context value={ctx}>{props.children}</Context>;
}

function Trigger(props: ButtonProps) {
  const c = use();
  const rest = omit(props, "onClick", "onKeyDown", "ref");
  return (
    <button
      type="button"
      {...rest}
      ref={refs(props.ref, c.setTrigger)}
      id={c.triggerId}
      aria-haspopup="menu"
      aria-expanded={c.open() ? "true" : "false"}
      aria-controls={c.open() ? c.popupId : undefined}
      data-popup-open={flag(c.open())}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
        e.preventDefault();
        c.setStart(e.key === "ArrowDown" ? "first" : "last");
        c.setOpen(true, "trigger");
      }}
      onClick={(e) => {
        call(props.onClick, e);
        if (e.defaultPrevented) return;
        // detail 0: Enter or Space, not a pointer.
        c.setStart(e.detail === 0 ? "first" : "menu");
        c.setOpen(!c.open(), "trigger");
      }}
    />
  );
}

function Popup(props: DivProps) {
  const c = use();
  const rest = omit(props, "ref", "onKeyDown");
  const [el, setEl] = createSignal<HTMLElement>();
  const typeahead = createTypeahead();
  focusWhenPlaced(c, el, (menu) => {
    const items = itemsIn(menu, item).filter((i) => !disabled(i));
    const start = c.start();
    return (start === "first" ? items[0] : start === "last" ? items.at(-1) : undefined) ?? menu;
  });
  return (
    <div
      role="menu"
      tabindex={-1}
      {...rest}
      ref={refs(props.ref, setEl)}
      id={c.popupId}
      aria-labelledby={c.triggerId}
      aria-orientation="vertical"
      {...openAttrs(c.open())}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        const menu = el();
        if (!menu || e.defaultPrevented) return;
        if (e.key === "Tab") return c.setOpen(false, "tab");
        if (roveFocus(e, menu, item, { orientation: "vertical", loop: true })) return;
        typeahead(e, menu, item);
      }}
    />
  );
}

export interface MenuItemProps extends DivProps {
  disabled?: boolean | undefined;
  /** Runs it without closing the menu. */
  closeOnClick?: boolean | undefined;
  /** What typing matches, when its text is not it. */
  label?: string | undefined;
}

function Item(props: MenuItemProps) {
  const c = use();
  const rest = omit(props, "disabled", "closeOnClick", "label", "onClick", "onKeyDown", "onPointerMove", "onPointerLeave", "onFocus", "onBlur");
  const [highlighted, setHighlighted] = createSignal(false);
  return (
    <div
      role="menuitem"
      tabindex={-1}
      {...rest}
      aria-disabled={props.disabled ? "true" : undefined}
      data-disabled={flag(props.disabled)}
      data-highlighted={flag(highlighted())}
      data-label={props.label}
      onFocus={(e) => {
        call(props.onFocus, e);
        setHighlighted(true);
      }}
      onBlur={(e) => {
        call(props.onBlur, e);
        setHighlighted(false);
      }}
      onPointerMove={(e) => {
        call(props.onPointerMove, e);
        if (!props.disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
      }}
      onPointerLeave={(e) => {
        call(props.onPointerLeave, e);
        if (document.activeElement === e.currentTarget) c.positioner()?.querySelector<HTMLElement>("[role=menu]")?.focus({ preventScroll: true });
      }}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.currentTarget.click();
      }}
      onClick={(e) => {
        if (props.disabled) return;
        call(props.onClick, e);
        if (!e.defaultPrevented && props.closeOnClick !== false) c.setOpen(false, "item");
      }}
    />
  );
}

function Separator(props: DivProps) {
  return <div role="separator" aria-orientation="horizontal" {...props} />;
}

const GroupContext = createContext<string | null>(null);

function Group(props: DivProps) {
  const id = createUniqueId();
  return (
    <GroupContext value={id}>
      <div role="group" aria-labelledby={id} {...props} />
    </GroupContext>
  );
}

function GroupLabel(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const id = useContext(GroupContext);
  return <div {...props} id={id ?? undefined} />;
}

export const Menu = {
  Root,
  Trigger,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "bottom", align: "start" }),
  Popup,
  Item,
  Separator,
  Group,
  GroupLabel,
};
