import type { JSX } from "@solidjs/web";
import { untrack } from "solid-js";

/** A state as a data attribute: present (empty) when on, absent when off. */
export const flag = (on: boolean | undefined): "" | undefined => (on === true ? "" : undefined);

/** Calls a handler given as a JSX prop: a function, or Solid's [handler, data] pair. */
export function call(handler: unknown, event: Event) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a JSX event prop: Solid's handler, or its [handler, data] pair
  if (typeof handler === "function") (handler as (e: Event) => void)(event);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a JSX event prop: Solid's handler, or its [handler, data] pair
  else if (Array.isArray(handler) && typeof handler[0] === "function") (handler[0] as (d: unknown, e: Event) => void)(handler[1], event);
}

/** A ref given as a JSX prop, and the component's own, both told of the element. */
export function refs<T extends HTMLElement>(props: { ref?: JSX.Ref<T> }, own: (el: T) => void) {
  return (el: T) => {
    // Ref callbacks belong to this element binding, not later parent prop updates.
    const given = untrack(() => props.ref);
    own(el);
    if (typeof given === "function") given(el);
  };
}

export type DivProps = JSX.HTMLAttributes<HTMLDivElement>;

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement>;

export type SpanProps = JSX.HTMLAttributes<HTMLSpanElement>;

/** What a part renders as (Base UI's render). */
export type Render = "button" | "span" | "div" | "a" | ((props: RenderProps) => JSX.Element);

/** What a component in `render` is given: an element's attributes, whichever element it makes. */
type RenderProps = Omit<JSX.HTMLAttributes<HTMLElement>, "ref"> & {
  // A plain callback, so the props spread onto any element's own ref type.
  ref?: ((el: HTMLElement) => void) | undefined;
};

export interface Renderable {
  render?: Render | undefined;
}

/** A button's type when the part is its own button; a component given in `render` sets its own. */
export const buttonType = (render: Render | undefined) => (render === undefined || render === "button" ? "button" : undefined);
