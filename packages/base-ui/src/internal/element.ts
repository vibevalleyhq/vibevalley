import type { JSX } from "@solidjs/web";

/** A state as a data attribute: present (empty) when on, absent when off. */
export const flag = (on: boolean | undefined): "" | undefined => (on ? "" : undefined);

/** Calls a handler given as a JSX prop: a function, or Solid's [handler, data] pair. */
export function call(handler: unknown, event: Event) {
  if (typeof handler === "function") (handler as (e: Event) => void)(event);
  else if (Array.isArray(handler) && typeof handler[0] === "function") (handler[0] as (d: unknown, e: Event) => void)(handler[1], event);
}

/** A ref given as a JSX prop, and the component's own, both told of the element. */
export function refs<T>(given: unknown, own: (el: T) => void) {
  return (el: T) => {
    own(el);
    if (typeof given === "function") (given as (el: T) => void)(el);
  };
}

export type DivProps = JSX.HTMLAttributes<HTMLDivElement>;

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement>;

export type SpanProps = JSX.HTMLAttributes<HTMLSpanElement>;

/**
 * What a part renders as (Base UI's render): its own element by default, another tag, or a component that is given
 * the part's props, ref and handlers included, to spread on its own element.
 */
export type Render = "button" | "span" | "div" | "a" | ((props: RenderProps) => JSX.Element);

/** What a component in `render` is given: an element's attributes, whichever element it makes. */
export type RenderProps = Omit<JSX.HTMLAttributes<HTMLElement>, "ref"> & {
  // A plain callback, so the props spread onto any element's own ref type.
  ref?: ((el: HTMLElement) => void) | undefined;
};

export interface Renderable {
  render?: Render | undefined;
}

/** A button's type when the part is its own button; a component given in `render` sets its own. */
export const buttonType = (render: Render | undefined) => (render === undefined || render === "button" ? "button" : undefined);
