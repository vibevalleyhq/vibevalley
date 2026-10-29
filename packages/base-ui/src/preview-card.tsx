// PreviewCard (Base UI's; shadcn's HoverCard): a card about a link, shown after the pointer rests on the link or the
// keyboard focuses it. Moving from the link onto the card keeps it open, so what is on it can be read and clicked;
// leaving both, a press outside or Escape closes it. It adds to the link, so nothing reads it as the link's description.

import { dynamic, type JSX } from "@solidjs/web";
import { createContext, omit, onCleanup, useContext } from "solid-js";
import { createDismiss } from "./internal/dismiss";
import { createFloating, type Floating, type FloatingRootProps, makePortal, makePositioner } from "./internal/floating";
import { call, type DivProps, flag, refs, type Render } from "./internal/element";

export type PreviewCardOpenChangeReason = "hover" | "focus" | "escape" | "outside";

interface Ctx extends Floating<PreviewCardOpenChangeReason> {
  /** Opens after the delay, or closes after the close delay; a later call replaces an earlier one. */
  readonly later: (open: boolean, why: PreviewCardOpenChangeReason) => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface PreviewCardRootProps extends FloatingRootProps<PreviewCardOpenChangeReason> {
  /** Wait before showing, ms. */
  delay?: number | undefined;
  /** Wait before hiding once the pointer has left the link and the card, ms. */
  closeDelay?: number | undefined;
}

function Root(props: PreviewCardRootProps) {
  const f = createFloating<PreviewCardOpenChangeReason>(props, "hover");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const ctx: Ctx = {
    ...f,
    later: (open, why) => {
      clearTimeout(timer);
      if (open === f.open()) return;
      const ms = open ? (props.delay ?? 600) : (props.closeDelay ?? 300);
      timer = setTimeout(() => f.setOpen(open, why), ms);
    },
  };
  createDismiss({
    open: f.open,
    elements: () => [f.trigger(), f.positioner()],
    dismiss: (why) => {
      clearTimeout(timer);
      f.setOpen(false, why);
    },
  });
  return <Context value={ctx}>{props.children}</Context>;
}

export interface PreviewCardTriggerProps extends JSX.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** A link by default. */
  render?: Render | undefined;
}

function Trigger(props: PreviewCardTriggerProps) {
  const c = use();
  const rest = omit(props, "render", "ref", "onPointerEnter", "onPointerLeave", "onFocus", "onBlur");
  const El = dynamic(() => props.render ?? "a");
  return (
    <El
      {...rest}
      ref={refs(props.ref, c.setTrigger)}
      data-popup-open={flag(c.open())}
      onPointerEnter={(e: PointerEvent) => {
        call(props.onPointerEnter, e);
        if (e.pointerType !== "touch") c.later(true, "hover");
      }}
      onPointerLeave={(e: PointerEvent) => {
        call(props.onPointerLeave, e);
        c.later(false, "hover");
      }}
      onFocus={(e: FocusEvent) => {
        call(props.onFocus, e);
        if (e.target instanceof Element && e.target.matches(":focus-visible")) c.later(true, "focus");
      }}
      onBlur={(e: FocusEvent) => {
        call(props.onBlur, e);
        c.later(false, "focus");
      }}
    />
  );
}

function Popup(props: DivProps) {
  const c = use();
  const rest = omit(props, "onPointerEnter", "onPointerLeave");
  return (
    <div
      {...rest}
      id={c.popupId}
      data-open={flag(c.open())}
      data-closed={flag(!c.open())}
      onPointerEnter={(e) => {
        call(props.onPointerEnter, e);
        // Keeps it open: cancels the close the link's leaving asked for.
        c.later(true, "hover");
      }}
      onPointerLeave={(e) => {
        call(props.onPointerLeave, e);
        c.later(false, "hover");
      }}
    />
  );
}

export const PreviewCard = {
  Root,
  Trigger,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "bottom", align: "center" }),
  Popup,
};
