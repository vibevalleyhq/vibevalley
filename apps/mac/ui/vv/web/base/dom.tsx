// Ported from VibeValley apps/web/src/base/dom.tsx: the same exports where
// nsh has the thing. There is no DOM: focus refs, click-away and the
// viewport come from nsh (autoFocus props, Overlay's onPressOutside,
// windowSize).
import { signal, untracked, type Accessor, type JSX } from "nsh";

import { createEffect, createSignal, onSettled } from "../../solid";

interface ClockBucket {
  readonly read: Accessor<number>;
  readonly write: (v: number) => void;
  refs: number;
  timer: ReturnType<typeof setInterval> | undefined;
}

const clockBuckets = new Map<number, ClockBucket>();

function acquireClockBucket(ms: number): ClockBucket {
  let bucket = clockBuckets.get(ms);
  if (!bucket) {
    const now = signal(Date.now());
    bucket = {
      read: () => now(),
      write: (v) => now.set(v),
      refs: 0,
      timer: undefined,
    };
    clockBuckets.set(ms, bucket);
  }
  return bucket;
}

/** The time, a new reading every `ms`: pooled per interval across active subscribers. */
export function useNow(ms = 30_000): Accessor<number> {
  const bucket = acquireClockBucket(ms);
  onSettled(() => {
    if (!clockBuckets.has(ms)) clockBuckets.set(ms, bucket);
    if (bucket.refs === 0) {
      bucket.write(Date.now());
      bucket.timer = setInterval(() => bucket.write(Date.now()), ms);
    }
    bucket.refs++;
    return () => {
      bucket.refs--;
      if (bucket.refs === 0) {
        clearInterval(bucket.timer);
        bucket.timer = undefined;
        if (clockBuckets.get(ms) === bucket) clockBuckets.delete(ms);
      }
    };
  });
  return bucket.read;
}

/** Rebuilds its children whenever `key` changes, as a React key does: their state starts over. */
export function Keyed(props: { key: unknown; children: () => JSX.Element }) {
  return <Each of={[props.key]}>{() => untracked(() => props.children())}</Each>;
}

/** The value once it has stopped changing for `ms`: what is asked of the server while someone types. */
export function createSettled<T>(value: Accessor<T>, ms = 250): Accessor<T> {
  const [settled, setSettled] = createSignal<T>(untracked(value));
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
