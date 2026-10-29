// What the components that float over the page (Popover, Tooltip, Menu, Select) share: an open state that says why it
// changed, the trigger and the positioner as elements, a Portal that puts the popup at the end of the body, and a
// Positioner that keeps it against the trigger and says on which side it ended up.

import { Portal as SolidPortal, type JSX } from "@solidjs/web";
import { type Accessor, createEffect, createSignal, createUniqueId, omit, onCleanup, Show } from "solid-js";
import { type Align, createAnchored, type Side } from "./anchored";
import { createControllable, type DivProps, flag, refs } from "./state";

export interface FloatingRootProps<R extends string> {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, reason: R) => void) | undefined;
  children?: JSX.Element;
}

export interface Floating<R extends string> {
  readonly open: Accessor<boolean>;
  readonly setOpen: (open: boolean, reason: R) => void;
  readonly trigger: Accessor<HTMLElement | undefined>;
  readonly setTrigger: (el: HTMLElement) => void;
  readonly positioner: Accessor<HTMLElement | undefined>;
  readonly setPositioner: (el: HTMLElement | undefined) => void;
  /** The positioner has its place: before that it is hidden, and what is hidden cannot take the focus. */
  readonly placed: Accessor<boolean>;
  readonly setPlaced: (placed: boolean) => void;
  readonly triggerId: string;
  readonly popupId: string;
}

/** What the shared parts read: everything but how to open or close, whose reasons each component names. */
export type FloatingParts = Omit<Floating<string>, "setOpen">;

export function createFloating<R extends string>(props: FloatingRootProps<R>, first: R): Floating<R> {
  let reason = first;
  const [open, setOpen] = createControllable({
    value: () => props.open,
    initial: props.defaultOpen ?? false,
    onChange: (v) => props.onOpenChange?.(v, reason),
  });
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  const [positioner, setPositioner] = createSignal<HTMLElement>();
  const [placed, setPlaced] = createSignal(false);
  return {
    open,
    setOpen: (v, why) => {
      reason = why;
      setOpen(v);
    },
    trigger,
    setTrigger,
    positioner,
    setPositioner,
    placed,
    setPlaced,
    triggerId: createUniqueId(),
    popupId: createUniqueId(),
  };
}

export interface PortalProps {
  children?: JSX.Element;
  /** Where to put it; by default the modal dialog the trigger is in, else the body. */
  container?: HTMLElement | undefined;
}

export function makePortal(use: () => FloatingParts) {
  return function Portal(props: PortalProps) {
    const c = use();
    return (
      <Show when={c.open()}>
        {/* In a modal dialog: the page outside it is inert and under its top layer, so the popup goes inside it. */}
        <SolidPortal mount={props.container ?? c.trigger()?.closest("dialog") ?? document.body}>{props.children}</SolidPortal>
      </Show>
    );
  };
}

export interface PositionerProps extends DivProps {
  side?: Side | undefined;
  align?: Align | undefined;
  /** Gap to the trigger, px. */
  sideOffset?: number | undefined;
  /** Distance kept from the window's edges, px. */
  collisionPadding?: number | undefined;
}

/** A fixed box placed against the trigger, with the popup inside; data-side and data-align say where it went. */
export function makePositioner(use: () => FloatingParts, defaults: { side: Side; align: Align }) {
  return function Positioner(props: PositionerProps) {
    const c = use();
    const rest = omit(props, "side", "align", "sideOffset", "collisionPadding", "ref", "style");
    const [box, setBox] = createSignal<HTMLElement>();
    const at = createAnchored(c.trigger, box, () => ({
      side: props.side ?? defaults.side,
      align: props.align ?? defaults.align,
      sideOffset: props.sideOffset,
      collisionPadding: props.collisionPadding,
    }));
    createEffect(
      () => at().placed,
      (p) => {
        c.setPlaced(p);
      },
    );
    onCleanup(() => {
      c.setPositioner(undefined);
      c.setPlaced(false);
    });
    return (
      <div
        {...rest}
        ref={refs(props.ref, (el: HTMLDivElement) => {
          setBox(el);
          c.setPositioner(el);
        })}
        style={{
          ...(typeof props.style === "object" ? props.style : {}),
          position: "fixed",
          left: `${at().x}px`,
          top: `${at().y}px`,
          // Base UI's: a list can be at least as wide as what opened it (min-width: var(--anchor-width)).
          "--anchor-width": `${at().anchorWidth}px`,
          // Not seen until placed: no flash in the corner.
          visibility: at().placed ? undefined : "hidden",
        }}
        data-side={at().side}
        data-align={at().align}
        data-open={flag(c.open())}
        data-closed={flag(!c.open())}
      />
    );
  };
}

/** What can take the focus by Tab. */
export const tabbable =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Once the positioner is placed, gives the focus to what `target` picks in the popup. */
export function focusWhenPlaced(c: FloatingParts, popup: Accessor<HTMLElement | undefined>, target: (popup: HTMLElement) => HTMLElement) {
  createEffect(
    () => (c.placed() ? popup() : undefined),
    (el) => {
      if (el) target(el).focus({ preventScroll: true });
    },
  );
}
