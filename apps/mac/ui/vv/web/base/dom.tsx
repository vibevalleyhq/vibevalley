// Ported from VibeValley apps/web/src/base/dom.tsx: the same exports where
// nsh has the thing. There is no DOM: focus refs, click-away and the
// viewport come from nsh (autoFocus props, Overlay's onPressOutside,
// windowSize).
import { untracked, type Accessor, type JSX } from "nsh";

import { createEffect, createSignal } from "../../solid";
import { useInterval } from "./timer";

/** The time, a new reading every `ms`: for "3m ago" that keeps up without anything else changing. */
export function useNow(ms = 30_000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

/** Rebuilds its children whenever `key` changes, as a React key does: their state starts over. */
export function Keyed(props: { key: unknown; children: () => JSX.Element }) {
  return <Each of={[props.key]}>{() => untracked(() => props.children())}</Each>;
}

/** The value once it has stopped changing for `ms`: what is asked of the server while someone types. */
export function createSettled<T>(value: Accessor<T>, ms = 250): Accessor<T> {
  const [settled, setSettled] = createSignal<T>(untracked(value) as Exclude<T, Function>);
  createEffect(value, (v) => {
    const t = setTimeout(() => setSettled(() => v), ms);
    return () => clearTimeout(t);
  });
  return settled;
}

export function variant<T, K extends keyof T, const V extends T[K]>(value: T, key: K, tag: V): Extract<T, Record<K, V>> | undefined {
  const is = (v: T): v is Extract<T, Record<K, V>> => v[key] === tag;
  return is(value) ? value : undefined;
}
