import { dynamic, type JSX } from "@solidjs/web";
import { createContext, createSignal, createUniqueId, omit, useContext } from "solid-js";

import { createDismiss } from "../base/dismiss";
import { type ButtonProps, buttonType, call, type DivProps, flag, refs, type Renderable } from "../base/element";
import { createFloating, type Floating, type FloatingRootProps, focusWhenPlaced, makePortal, makePositioner } from "../base/floating";
import { createTypeahead, disabled, itemsIn, roveFocus } from "../base/roving";

export type MenuOpenChangeReason = "trigger" | "item" | "escape" | "outside" | "tab";

const item = "[role=menuitem]";

interface MenuCtx extends Floating<MenuOpenChangeReason> {
  /** Where the focus goes once the menu is placed. */
  readonly start: () => "first" | "last" | "menu";
  readonly setStart: (start: "first" | "last" | "menu") => void;
  /** The id that names the menu: its trigger's, when the trigger is a button that says something. */
  readonly labelledBy: () => string | undefined;
}

export const MenuContext = createContext<MenuCtx>();
const use = () => useContext(MenuContext);

export type MenuRootProps = FloatingRootProps<MenuOpenChangeReason>;

/** A menu's state; `returnTo` is where the focus goes back when it closes other than by an outside press. */
export function createMenu(props: MenuRootProps, o: { returnTo: () => HTMLElement | undefined; labelledBy: (triggerId: string) => string | undefined }) {
  const f = createFloating<MenuOpenChangeReason>(props, "trigger");
  const [start, setStart] = createSignal<"first" | "last" | "menu">("menu");
  const ctx: MenuCtx = {
    ...f,
    setOpen: (open, why) => {
      f.setOpen(open, why);
      if (!open && why !== "outside") o.returnTo()?.focus();
    },
    start,
    setStart,
    labelledBy: () => o.labelledBy(f.triggerId),
  };
  createDismiss({ open: f.open, elements: () => [f.trigger(), f.positioner()], dismiss: (why) => ctx.setOpen(false, why) });
  return ctx;
}

function Root(props: MenuRootProps) {
  const ctx: MenuCtx = createMenu(props, { returnTo: () => ctx.trigger(), labelledBy: (id) => id });
  return <MenuContext value={ctx}>{props.children}</MenuContext>;
}

function Trigger(props: ButtonProps & Renderable) {
  const c = use();
  const rest = omit(props, "render", "onClick", "onKeyDown", "ref");
  const El = dynamic(() => props.render ?? "button");
  return (
    <El
      type={buttonType(props.render)}
      {...rest}
      ref={refs(props, c.setTrigger)}
      id={c.triggerId}
      aria-haspopup="menu"
      aria-expanded={c.open() ? "true" : "false"}
      aria-controls={c.open() ? c.popupId : undefined}
      data-popup-open={flag(c.open())}
      onKeyDown={(e: KeyboardEvent) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
        e.preventDefault();
        c.setStart(e.key === "ArrowDown" ? "first" : "last");
        c.setOpen(true, "trigger");
      }}
      onClick={(e: MouseEvent) => {
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
      ref={refs(props, setEl)}
      id={c.popupId}
      aria-labelledby={c.labelledBy()}
      aria-orientation="vertical"
      data-open={flag(c.open())}
      data-closed={flag(!c.open())}
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
      aria-disabled={props.disabled === true ? "true" : undefined}
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
        if (props.disabled !== true && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
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
        if (props.disabled === true) return;
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
