// Popover (Base UI's): a popup against its trigger with content to read or use, not modal. Opening gives it the focus;
// Escape and the close button give it back to the trigger, a press outside leaves it where the press put it.

import { dynamic, type JSX } from "@solidjs/web";
import { createContext, createSignal, omit, onSettled, useContext } from "solid-js";
import { createDismiss } from "./internal/dismiss";
import { createFloating, type Floating, type FloatingRootProps, focusWhenPlaced, makePortal, makePositioner, tabbable } from "./internal/floating";
import { type ButtonProps, buttonType, call, type DivProps, flag, openAttrs, refs, type Renderable } from "./internal/state";

export type PopoverOpenChangeReason = "trigger" | "escape" | "outside" | "close";

interface Ctx extends Floating<PopoverOpenChangeReason> {
  readonly titleId: () => string | undefined;
  readonly setTitleId: (id: string | undefined) => void;
  readonly descriptionId: () => string | undefined;
  readonly setDescriptionId: (id: string | undefined) => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export type PopoverRootProps = FloatingRootProps<PopoverOpenChangeReason>;

function Root(props: PopoverRootProps) {
  const f = createFloating<PopoverOpenChangeReason>(props, "trigger");
  const [titleId, setTitleId] = createSignal<string>();
  const [descriptionId, setDescriptionId] = createSignal<string>();
  const ctx: Ctx = {
    ...f,
    setOpen: (open, why) => {
      f.setOpen(open, why);
      if (!open && (why === "escape" || why === "close")) f.trigger()?.focus();
    },
    titleId,
    setTitleId,
    descriptionId,
    setDescriptionId,
  };
  createDismiss({ open: f.open, elements: () => [f.trigger(), f.positioner()], dismiss: (why) => ctx.setOpen(false, why) });
  return <Context value={ctx}>{props.children}</Context>;
}

function Trigger(props: ButtonProps & Renderable) {
  const c = use();
  const rest = omit(props, "render", "onClick", "ref");
  const El = dynamic(() => props.render ?? "button");
  return (
    <El
      type={buttonType(props.render)}
      {...rest}
      ref={refs(props.ref, c.setTrigger)}
      aria-haspopup="dialog"
      aria-expanded={c.open() ? "true" : "false"}
      aria-controls={c.open() ? c.popupId : undefined}
      data-popup-open={flag(c.open())}
      onClick={(e: MouseEvent) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) c.setOpen(!c.open(), "trigger");
      }}
    />
  );
}

function Popup(props: DivProps) {
  const c = use();
  const rest = omit(props, "ref");
  const [el, setEl] = createSignal<HTMLElement>();
  focusWhenPlaced(c, el, (p) => p.querySelector<HTMLElement>(tabbable) ?? p);
  return (
    <div
      role="dialog"
      tabindex={-1}
      {...rest}
      ref={refs(props.ref, setEl)}
      id={c.popupId}
      aria-labelledby={c.titleId()}
      aria-describedby={c.descriptionId()}
      {...openAttrs(c.open())}
    />
  );
}

function Title(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const c = use();
  const id = `${c.popupId}-title`;
  onSettled(() => (c.setTitleId(id), () => c.setTitleId(undefined)));
  return <h2 {...props} id={id} />;
}

function Description(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const c = use();
  const id = `${c.popupId}-description`;
  onSettled(() => (c.setDescriptionId(id), () => c.setDescriptionId(undefined)));
  return <p {...props} id={id} />;
}

function Close(props: ButtonProps & Renderable) {
  const c = use();
  const rest = omit(props, "render", "onClick");
  const El = dynamic(() => props.render ?? "button");
  return (
    <El
      type={buttonType(props.render)}
      {...rest}
      onClick={(e: MouseEvent) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) c.setOpen(false, "close");
      }}
    />
  );
}

export const Popover = {
  Root,
  Trigger,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "bottom", align: "center" }),
  Popup,
  Title,
  Description,
  Close,
};
