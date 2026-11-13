// The part of Solid 2 (solid-js 2.0.0-rc.21) the reused VibeValley web code
// calls, on nsh's own reactivity. nsh's bundler refuses `solid-js`; the
// The views import `solid-js` from here.
// Views ported to nsh use nsh directly (signal, computed, effect, If, Each).
import { batch as nshBatch, cleanup, computed, context, effect, signal, untracked, type Context as NshContext } from "nsh";

export type Accessor<T> = () => T;
export type Setter<T> = (value: T | ((prev: T) => T)) => T;
type SignalOptions<T> = { equals?: false | ((a: T, b: T) => boolean); name?: string; ownedWrite?: boolean };

export function createSignal<T>(): [Accessor<T | undefined>, Setter<T | undefined>];
export function createSignal<T>(value: T, options?: SignalOptions<T>): [Accessor<T>, Setter<T>];
export function createSignal<T>(value?: T, options?: SignalOptions<T>): [Accessor<T | undefined>, Setter<T | undefined>] {
  const equals = options?.equals;
  // nsh compares with Object.is; `equals: false` notifies every set, done here by boxing.
  if (equals === false) {
    const box = signal<{ v: T | undefined }>({ v: value });
    const get = () => box().v;
    const set: Setter<T | undefined> = (next) => {
      const v = typeof next === "function" ? (next as (p: T | undefined) => T | undefined)(untracked(get)) : next;
      box.set({ v });
      return v;
    };
    return [get, set];
  }
  const s = signal<T | undefined>(value);
  const set: Setter<T | undefined> = (next) => {
    const prev = untracked(() => s());
    const v = typeof next === "function" ? (next as (p: T | undefined) => T | undefined)(prev) : next;
    if (!(equals && prev !== undefined && v !== undefined && equals(prev as T, v as T))) s.set(v);
    return v;
  };
  return [() => s(), set];
}

export function createMemo<T>(fn: (prev: T | undefined) => T, _initial?: T, _options?: SignalOptions<T>): Accessor<T> {
  return computed(fn);
}

/**
 * Solid 2's split effect: `compute` is tracked, `apply(value, prev)` runs
 * untracked with its result and may return a cleanup. `defer` skips the
 * first run.
 */
export function createEffect<T>(
  compute: (prev: T | undefined) => T,
  // Solid 2 drops what apply returns unless it is a function (its cleanup): `(p) => setX(p)` is fine.
  apply?: (value: T, prev: T | undefined) => unknown,
  options?: { defer?: boolean },
): void {
  let prev: T | undefined;
  let first = true;
  effect(() => {
    const value = compute(prev);
    const skip = first && options?.defer === true;
    first = false;
    const before = prev;
    prev = value;
    if (skip || !apply) return;
    const done = untracked(() => apply(value, before));
    return typeof done === "function" ? (done as () => void) : undefined;
  });
}

export const createRenderEffect = createEffect;

/** Runs once the owner has mounted; its returned function runs when the owner goes. */
export function onSettled(fn: () => void | (() => void)): void {
  effect(() => untracked(fn) ?? undefined);
}

export const onCleanup = cleanup;
export const untrack = untracked;
export const batch = nshBatch;
/** nsh applies writes at once; there is nothing pending to flush. */
export const flush = (): void => {};
/** Tracks a value as a whole; nsh's plain objects are not reactive, so the value is returned as it is. */
export const deep = <T>(value: T): T => value;
export const snapshot = <T>(value: T): T => value;

export type Context<T> = NshContext<T>;
export function createContext<T>(defaultValue?: T): Context<T> {
  return context<T>(defaultValue as T);
}
/** An nsh context is its own accessor. */
export function useContext<T>(ctx: Context<T>): T {
  return ctx();
}
/** nsh has no owner handle; callers only test it for presence. */
export const getOwner = (): object | null => ({});
