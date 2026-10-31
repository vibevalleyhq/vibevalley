// A read asked again as the owner types (a search) or as the place changes (a channel's pins): only the answer to the
// newest ask is shown. An answer to an older one may come last, and would otherwise put what was asked before back on
// screen; a failure is an answer too, shown as such and not as "nothing found".

import { type Accessor, createEffect, createSignal } from "solid-js";

import { reasonOf } from "./api";

export type Answer<T> = { readonly state: "waiting" } | { readonly state: "done"; readonly value: T } | { readonly state: "failed"; readonly reason: string };

export interface Reader<K> {
  /** Reads after the wait; undefined reads nothing and tells undefined. Any answer to an earlier ask is dropped. */
  readonly request: (key: K | undefined) => void;
  /** Drops whatever is on its way. */
  readonly stop: () => void;
}

/** Framework-free, for the test: `told` hears each state of the newest ask only. */
export function latestReader<K, T>(read: (key: K) => Promise<T>, waitMs: number, told: (answer: Answer<T> | undefined) => void): Reader<K> {
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    asked++;
    clearTimeout(timer);
  };
  return {
    stop,
    request: (key) => {
      stop();
      if (key === undefined) return told(undefined);
      const mine = asked;
      told({ state: "waiting" });
      const go = () =>
        void read(key).then(
          (value) => mine === asked && told({ state: "done", value }),
          (e: unknown) => mine === asked && told({ state: "failed", reason: reasonOf(e) }),
        );
      if (waitMs <= 0) go();
      else timer = setTimeout(go, waitMs);
    },
  };
}

/** The answer to the newest `key()` while the component lives; undefined while there is nothing to ask. */
export function useLatest<K, T>(key: Accessor<K | undefined>, read: (key: K) => Promise<T>, waitMs = 0): Accessor<Answer<T> | undefined> {
  const [answer, setAnswer] = createSignal<Answer<T> | undefined>(undefined);
  const reader = latestReader(read, waitMs, (a) => setAnswer(() => a));
  createEffect(key, (k) => {
    reader.request(k);
    return reader.stop;
  });
  return answer;
}
