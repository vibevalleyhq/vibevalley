// Tooltip (Base UI's): a few words about its trigger, shown after the pointer rests on it or at once when the keyboard
// focuses it, gone when either leaves, on a press or on Escape. Once one has shown, the next opens without the wait,
// so moving along a toolbar reads each button's tip. Its trigger is described by it while it shows.

import { dynamic, type JSX } from "@solidjs/web";
import { createContext, createEffect, omit, onCleanup, useContext } from "solid-js";
import { createDismiss } from "./internal/dismiss.ts";
import { createFloating, type Floating, type FloatingRootProps, makePortal, makePositioner } from "./internal/floating.tsx";
import { call, type DivProps, flag, openAttrs, refs } from "./internal/state.ts";

export type TooltipOpenChangeReason = "hover" | "focus" | "press" | "escape" | "outside";

/** Within this long of a tooltip closing, the next opens without its delay. */
const warmMs = 400;
let warmUntil = 0;
let showing = 0;

interface Ctx extends Floating<TooltipOpenChangeReason> {
  readonly delay: () => number;
  readonly closeDelay: () => number;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface TooltipRootProps extends FloatingRootProps<TooltipOpenChangeReason> {
  /** Wait before showing on hover, ms. */
  delay?: number | undefined;
  /** Wait before hiding once the pointer leaves, ms. */
  closeDelay?: number | undefined;
}

function Root(props: TooltipRootProps) {
  const f = createFloating<TooltipOpenChangeReason>(props, "hover");
  const ctx: Ctx = { ...f, delay: () => props.delay ?? 600, closeDelay: () => props.closeDelay ?? 0 };
  createDismiss({ open: f.open, elements: () => [f.trigger()], dismiss: (why) => f.setOpen(false, why) });
  return <Context value={ctx}>{props.children}</Context>;
}

export interface TooltipTriggerProps extends JSX.HTMLAttributes<HTMLElement> {
  /** The element it is; a button by default, a span to wrap something that is focusable itself. */
  as?: "button" | "span" | "div" | "a" | undefined;
}

function Trigger(props: TooltipTriggerProps) {
  const c = use();
  const rest = omit(props, "as", "ref", "onPointerEnter", "onPointerLeave", "onPointerDown", "onFocusIn", "onFocusOut");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number, run: () => void) => {
    clearTimeout(timer);
    timer = ms > 0 ? setTimeout(run, ms) : undefined;
    if (ms <= 0) run();
  };
  const show = (why: TooltipOpenChangeReason) => {
    if (c.open()) return;
    c.setOpen(true, why);
  };
  const hide = (why: TooltipOpenChangeReason) => {
    clearTimeout(timer);
    if (c.open()) c.setOpen(false, why);
  };
  // Counts this tooltip as showing, and warms the next once it hides.
  let counted = false;
  const track = (open: boolean) => {
    if (open && !counted) showing++;
    if (!open && counted) {
      showing--;
      warmUntil = Date.now() + warmMs;
    }
    counted = open;
  };
  createEffect(c.open, (open) => {
    track(open);
  });
  onCleanup(() => {
    clearTimeout(timer);
    track(false);
  });
  const El = dynamic(() => props.as ?? "button");
  return (
    <El
      type={(props.as ?? "button") === "button" ? "button" : undefined}
      {...rest}
      ref={refs(props.ref, c.setTrigger)}
      aria-describedby={c.open() ? c.popupId : undefined}
      data-popup-open={flag(c.open())}
      onPointerEnter={(e: PointerEvent) => {
        call(props.onPointerEnter, e);
        if (e.pointerType === "touch") return;
        later(showing > 0 || Date.now() < warmUntil ? 0 : c.delay(), () => show("hover"));
      }}
      onPointerLeave={(e: PointerEvent) => {
        call(props.onPointerLeave, e);
        later(c.closeDelay(), () => hide("hover"));
      }}
      onPointerDown={(e: PointerEvent) => {
        call(props.onPointerDown, e);
        hide("press");
      }}
      onFocusIn={(e: FocusEvent) => {
        call(props.onFocusIn, e);
        // Only the keyboard's focus: a click focuses a button too, and must not show its tip.
        if (e.target instanceof Element && e.target.matches(":focus-visible")) later(0, () => show("focus"));
      }}
      onFocusOut={(e: FocusEvent) => {
        call(props.onFocusOut, e);
        if (!(e.relatedTarget instanceof Node && (e.currentTarget as Element).contains(e.relatedTarget))) hide("focus");
      }}
    />
  );
}

function Popup(props: DivProps) {
  const c = use();
  return <div {...props} role="tooltip" id={c.popupId} {...openAttrs(c.open())} />;
}

export const Tooltip = {
  Root,
  Trigger,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "top", align: "center" }),
  Popup,
};
