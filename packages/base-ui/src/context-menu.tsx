// ContextMenu (Base UI's): the Menu that a right click (or the context menu key) opens at the pointer over an area.
// Its popup, items and keys are the Menu's; it closes the same ways and gives the focus back to the area.

import { createContext, createSignal, omit, useContext } from "solid-js";
import { makePortal, makePositioner } from "./internal/floating";
import { call, type DivProps, flag, refs } from "./internal/element";
import { createMenu, Menu, MenuContext, type MenuRootProps } from "./menu";

const use = () => useContext(MenuContext);

interface AreaCtx {
  readonly at: () => { readonly x: number; readonly y: number };
  readonly setAt: (at: { x: number; y: number }) => void;
  readonly setArea: (el: HTMLElement) => void;
}

const AreaContext = createContext<AreaCtx>();

function Root(props: MenuRootProps) {
  const [at, setAt] = createSignal({ x: 0, y: 0 });
  const [area, setArea] = createSignal<HTMLElement>();
  // No trigger says what the menu is: name it with aria-label on the popup.
  const ctx = createMenu(props, { returnTo: area, labelledBy: () => undefined });
  return (
    <MenuContext value={ctx}>
      <AreaContext value={{ at, setAt, setArea }}>{props.children}</AreaContext>
    </MenuContext>
  );
}

/** The area a right click opens the menu over; the menu is placed against a zero-size anchor at the pointer. */
function Trigger(props: DivProps) {
  const c = use();
  const a = useContext(AreaContext);
  const rest = omit(props, "onContextMenu", "onKeyDown", "ref", "children");
  const open = (x: number, y: number, start: "first" | "menu") => {
    a.setAt({ x, y });
    c.setStart(start);
    c.setOpen(true, "trigger");
  };
  return (
    <div
      {...rest}
      ref={refs(props.ref, a.setArea)}
      data-popup-open={flag(c.open())}
      onContextMenu={(e) => {
        call(props.onContextMenu, e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        open(e.clientX, e.clientY, "menu");
      }}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        open(r.left, r.bottom, "first");
      }}
    >
      {props.children}
      <span ref={c.setTrigger} aria-hidden="true" style={{ position: "fixed", left: `${a.at().x}px`, top: `${a.at().y}px`, width: "0", height: "0" }} />
    </div>
  );
}

export const ContextMenu = {
  Root,
  Trigger,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "bottom", align: "start" }),
  Popup: Menu.Popup,
  Item: Menu.Item,
  Separator: Menu.Separator,
  Group: Menu.Group,
  GroupLabel: Menu.GroupLabel,
};
