import { type Accessor, createEffect, createSignal, For, onSettled, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

/** A ref that focuses its element once it is on the page: what React's autoFocus does on mount. */
export function autofocus<T extends HTMLElement>() {
  let el: T | undefined;
  onSettled(() => el?.focus());
  return (next: T) => {
    el = next;
  };
}

/** The time, a new reading every `ms`: for "3 分钟前" that keeps up without anything else changing. */
export function useNow(ms = 30_000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  onSettled(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  });
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
  const [settled, setSettled] = createSignal<T>(untrack(value) as Exclude<T, Function>);
  createEffect(value, (v) => {
    const t = setTimeout(() => setSettled(() => v), ms);
    return () => clearTimeout(t);
  });
  return settled;
}

/**
 * A ref for a <select> that sets its value again whenever the value or the options change: options that arrive after the
 * value (a list still loading) would otherwise leave the first option chosen.
 */
export function useSelectValue(value: Accessor<string>, options: Accessor<unknown>) {
  let el: HTMLSelectElement | undefined;
  createEffect(
    () => [value(), options()] as const,
    ([v]) => {
      if (el) el.value = v;
    },
  );
  return (s: HTMLSelectElement) => {
    el = s;
  };
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
      if (box && !box.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  });
  return (el: HTMLElement) => {
    box = el;
  };
}
