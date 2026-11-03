import type { JSX } from "@solidjs/web";
import { type Accessor, createEffect, createSignal, For, onSettled, untrack } from "solid-js";

import { useInterval } from "./timer";

/** A ref that focuses its element once it is on the page: what React's autoFocus does on mount. */
export function autofocus() {
  let el: HTMLElement | undefined;
  onSettled(() => el?.focus());
  return (next: HTMLElement) => {
    el = next;
  };
}

/** The time, a new reading every `ms`: for "3 分钟前" that keeps up without anything else changing. */
export function useNow(ms = 30_000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

/** Rebuilds its children whenever `key` changes, as a React key does: their state starts over. */
export function Keyed(props: { key: unknown; children: () => JSX.Element }) {
  return <For each={[props.key]}>{() => props.children()}</For>;
}

/** aria-expanded, aria-pressed, aria-selected: "true" or "false", as a boolean false would drop the attribute. */
export const aria = (on: boolean) => (on ? "true" : "false");

/** The window's size, following it as it is resized. */
export function useViewport(): Accessor<{ w: number; h: number }> {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = createSignal(read());
  onSettled(() => {
    const on = () => setSize(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  });
  return size;
}

/** The value once it has stopped changing for `ms`: what is asked of the server while someone types. */
export function createSettled<T>(value: Accessor<T>, ms = 250): Accessor<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Solid reads a function as a compute; a T that is one goes through the setter's updater form below
  const [settled, setSettled] = createSignal<T>(untrack(value) as Exclude<T, Function>);
  createEffect(value, (v) => {
    const t = setTimeout(() => setSettled(() => v), ms);
    return () => clearTimeout(t);
  });
  return settled;
}

/**
 * Closes a popup when the pointer goes down outside `box` while `open`: a menu folds when you click elsewhere. Returns
 * the ref for the box (the popup and what opens it, so the opener's own click still toggles). Escape is the page's to
 * give: on the farm it opens the menu.
 */
export function useClickAway(open: Accessor<boolean>, close: () => void) {
  let box: HTMLElement | undefined;
  createEffect(open, (on) => {
    if (!on) return;
    const away = (e: PointerEvent) => {
      if (box && !(e.target instanceof Node && box.contains(e.target))) close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  });
  return (el: HTMLElement) => {
    box = el;
  };
}

export function variant<T, K extends keyof T, const V extends T[K]>(value: T, key: K, tag: V): Extract<T, Record<K, V>> | undefined {
  const is = (v: T): v is Extract<T, Record<K, V>> => v[key] === tag;
  return is(value) ? value : undefined;
}

/** A JSON object's fields, each still to be checked; undefined for anything that is not an object. */
export const recordOf = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : undefined;
