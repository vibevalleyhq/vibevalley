// Dialog and AlertDialog (Base UI's), on the native <dialog>: shown with showModal it is in the top layer, keeps the
// focus inside and makes the page behind inert, and the browser gives the focus back to what had it when it closes.
// Escape and (for a Dialog, not an AlertDialog) a press on the backdrop ask to close; whether it is open is the Root's.

import { dynamic, type JSX } from "@solidjs/web";
import { createContext, createEffect, createSignal, createUniqueId, omit, onSettled, Show, useContext } from "solid-js";
import { type ButtonProps, buttonType, call, flag, refs, type Renderable } from "./internal/element";
import { createControllable } from "./internal/controllable";

export type DialogCloseReason = "escape" | "outside" | "close" | "trigger";

interface Ctx {
  readonly open: () => boolean;
  readonly setOpen: (open: boolean, reason: DialogCloseReason) => void;
  readonly alert: boolean;
  readonly titleId: string;
  readonly descriptionId: string;
  readonly hasTitle: () => boolean;
  readonly hasDescription: () => boolean;
  readonly titled: () => () => void;
  readonly described: () => () => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface DialogRootProps {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, reason: DialogCloseReason) => void) | undefined;
  children?: JSX.Element;
}

const makeRoot = (alert: boolean) =>
  function Root(props: DialogRootProps) {
    let reason: DialogCloseReason = "trigger";
    const [open, setOpen] = createControllable({
      value: () => props.open,
      initial: props.defaultOpen ?? false,
      onChange: (v) => props.onOpenChange?.(v, reason),
    });
    const [titles, setTitles] = createSignal(0);
    const [descriptions, setDescriptions] = createSignal(0);
    const ctx: Ctx = {
      open,
      setOpen: (v, why) => {
        reason = why;
        setOpen(v);
      },
      alert,
      titleId: createUniqueId(),
      descriptionId: createUniqueId(),
      hasTitle: () => titles() > 0,
      hasDescription: () => descriptions() > 0,
      titled: () => (setTitles((n) => n + 1), () => setTitles((n) => n - 1)),
      described: () => (setDescriptions((n) => n + 1), () => setDescriptions((n) => n - 1)),
    };
    return <Context value={ctx}>{props.children}</Context>;
  };

function Trigger(props: ButtonProps & Renderable) {
  const c = use();
  const rest = omit(props, "render", "onClick");
  const El = dynamic(() => props.render ?? "button");
  return (
    <El
      type={buttonType(props.render)}
      {...rest}
      aria-haspopup="dialog"
      aria-expanded={c.open() ? "true" : "false"}
      data-popup-open={flag(c.open())}
      onClick={(e: MouseEvent) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) c.setOpen(!c.open(), "trigger");
      }}
    />
  );
}

export interface DialogPopupProps extends JSX.DialogHtmlAttributes<HTMLDialogElement> {
  /** Kept in the page while closed (its content too), only not shown. */
  keepMounted?: boolean | undefined;
}

function Popup(props: DialogPopupProps) {
  const c = use();
  const rest = omit(props, "keepMounted", "ref", "onCancel", "onClose", "onClick", "children");
  let dialog: HTMLDialogElement | undefined;
  createEffect(c.open, (on) => {
    if (!dialog) return;
    if (on && !dialog.open) dialog.showModal();
    if (!on && dialog.open) dialog.close();
  });
  return (
    <dialog
      {...rest}
      ref={refs(props.ref, (el: HTMLDialogElement) => (dialog = el))}
      role={c.alert ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={c.hasTitle() ? c.titleId : undefined}
      aria-describedby={c.hasDescription() ? c.descriptionId : undefined}
      data-open={flag(c.open())}
      data-closed={flag(!c.open())}
      onCancel={(e) => {
        call(props.onCancel, e);
        e.preventDefault();
        c.setOpen(false, "escape");
      }}
      // Closed by the browser without a cancel (Escape twice): the Root still hears of it.
      onClose={(e) => {
        call(props.onClose, e);
        if (c.open()) c.setOpen(false, "escape");
      }}
      onClick={(e) => {
        call(props.onClick, e);
        if (!c.alert && e.target === dialog) c.setOpen(false, "outside");
      }}
    >
      <Show when={c.open() || props.keepMounted}>{props.children}</Show>
    </dialog>
  );
}

function Title(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const c = use();
  onSettled(c.titled);
  return <h2 {...props} id={c.titleId} />;
}

function Description(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const c = use();
  onSettled(c.described);
  return <p {...props} id={c.descriptionId} />;
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

export const Dialog = { Root: makeRoot(false), Trigger, Popup, Title, Description, Close };
/** A Dialog that must be answered: a press on the backdrop does not close it, and it reads as an alert dialog. */
export const AlertDialog = { Root: makeRoot(true), Trigger, Popup, Title, Description, Close };
