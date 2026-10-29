// Toolbar (Base UI's): a row of controls that is one tab stop; the arrow keys, Home and End move among its buttons,
// links and inputs, and Tab leaves it. The tab stop stays on the item focused last.

import { createContext, createSignal, omit, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Orientation } from "./internal/composite";
import { itemsIn, roveFocus } from "./internal/roving";
import { type ButtonProps, call, type DivProps, flag, refs } from "./internal/element";

interface Ctx {
  readonly orientation: () => Orientation;
  readonly isStop: (el: HTMLElement | undefined) => boolean;
}

const Context = createContext<Ctx>();

const item = "[data-toolbar-item]";

function Root(props: DivProps & { orientation?: Orientation | undefined; loop?: boolean | undefined }) {
  const rest = omit(props, "orientation", "loop", "ref", "onKeyDown", "onFocusIn");
  const [stop, setStop] = createSignal<HTMLElement>();
  let root: HTMLDivElement | undefined;
  const ctx: Ctx = {
    orientation: () => props.orientation ?? "horizontal",
    // Until an item has had the focus, the first enabled one is the stop.
    isStop: (el) => (el ? (stop() && stop()!.isConnected ? stop() === el : root !== undefined && itemsIn(root, `${item}:not([disabled])`)[0] === el) : false),
  };
  return (
    <Context value={ctx}>
      <div
        role="toolbar"
        {...rest}
        ref={refs(props.ref, (el: HTMLDivElement) => {
          root = el;
          queueMicrotask(() => setStop(itemsIn(el, `${item}:not([disabled])`)[0]));
        })}
        aria-orientation={ctx.orientation()}
        data-orientation={ctx.orientation()}
        onFocusIn={(e) => {
          call(props.onFocusIn, e);
          if (e.target instanceof HTMLElement && e.target.matches(item)) setStop(e.target);
        }}
        onKeyDown={(e) => {
          call(props.onKeyDown, e);
          // Only its own items' keys: something opened inside it (a picker, a menu) keeps its arrows.
          if (!root || e.defaultPrevented || !(e.target instanceof HTMLElement) || !e.target.matches(item)) return;
          // An input keeps its own left and right.
          if (e.target instanceof HTMLInputElement && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
          roveFocus(e, root, `${item}:not([disabled])`, { orientation: ctx.orientation(), loop: props.loop ?? true });
        }}
      />
    </Context>
  );
}

/** Wires an element into the toolbar's roving tab stop. */
function useItem() {
  const c = useContext(Context);
  const [el, setEl] = createSignal<HTMLElement>();
  return { setEl, tabindex: () => (c.isStop(el()) ? 0 : -1), orientation: c.orientation };
}

function Button(props: ButtonProps) {
  const i = useItem();
  return (
    <button
      type="button"
      {...omit(props, "ref")}
      ref={refs(props.ref, i.setEl)}
      tabindex={i.tabindex()}
      data-toolbar-item=""
      data-orientation={i.orientation()}
      data-disabled={flag(Boolean(props.disabled))}
    />
  );
}

function Link(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const i = useItem();
  return <a {...omit(props, "ref")} ref={refs(props.ref, i.setEl)} tabindex={i.tabindex()} data-toolbar-item="" data-orientation={i.orientation()} />;
}

function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const i = useItem();
  return <input {...omit(props, "ref")} ref={refs(props.ref, i.setEl)} tabindex={i.tabindex()} data-toolbar-item="" data-orientation={i.orientation()} />;
}

function Group(props: DivProps) {
  return <div role="group" {...props} />;
}

function Separator(props: DivProps) {
  const c = useContext(Context);
  // A toolbar's separator runs across it.
  const across = () => (c.orientation() === "horizontal" ? "vertical" : "horizontal");
  return <div role="separator" {...props} aria-orientation={across()} data-orientation={across()} />;
}

export const Toolbar = { Root, Button, Link, Input, Group, Separator };
