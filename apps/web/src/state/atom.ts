// The page's middle layer stands on Effect's Atom (effect/reactivity). Its API is marked unstable, so only state/ imports it
// (lint vibevalley/atom-door): a change in it is fixed here and in intent.ts, and features read atoms through what these
// files export. Effect's own Solid binding (@effect/atom-solid) wants solid-js 1, and its reads suspend; this one is a
// subscription read as a signal (createExternal), so a value an atom has not got yet never holds up the state frames.

import { Atom, AtomRegistry } from "effect/reactivity";
import { type Accessor, createContext, createEffect, createSignal, useContext } from "solid-js";

import { createExternal } from "#/base/external.ts";
import { reasonOf } from "#/infra/api.ts";
import { type Frames, frames, type FramesSource, type Link } from "#/infra/frame.ts";

export const createRegistry = (): AtomRegistry.AtomRegistry => AtomRegistry.make();

/**
 * The page's one registry. Root gives it, and the page's own values (defineAtom, defineStored) live in it, since plain
 * code (a toast said from a rule, a pref set from a key) writes them with no component around. Tests make their own for
 * intents (state/testing.ts).
 */
export const pageRegistry: AtomRegistry.AtomRegistry = createRegistry();

/** Every atom's value lives in one registry for the page; the page's own unless a test or a story gives another. */
export const RegistryContext = createContext<AtomRegistry.AtomRegistry>(pageRegistry);

export const useRegistry = (): AtomRegistry.AtomRegistry => useContext(RegistryContext);

/** An atom's value as an accessor: subscribed while the component lives, never suspending. */
export function useAtom<A>(atom: Atom.Atom<A>, registry: AtomRegistry.AtomRegistry = useRegistry()): Accessor<A> {
  return createExternal(
    (changed) => registry.subscribe(atom, changed),
    () => registry.get(atom),
  );
}

/** A value the page keeps for its life, in the page's registry: one way for a feature to keep what is not a component's. */
export interface PageAtom<A> {
  /** The value now; a computation or a component that reads it runs again when it changes. */
  readonly get: () => A;
  readonly set: (value: A) => void;
  readonly update: (change: (value: A) => A) => void;
  /** Hears every change, for code outside Solid (the canvas, the sounds, another store). */
  readonly subscribe: (changed: () => void) => () => void;
}

/**
 * The atom held for the page's life, with a signal that only counts its changes: a read returns the registry's value
 * itself, so code that sets and reads at once (an event handler) sees the new value before Solid's next flush.
 */
export function onPage<A>(atom: Atom.Writable<A>): PageAtom<A> {
  const kept = Atom.keepAlive(atom);
  const [changes, setChanges] = createSignal(0);
  // At once: a node not read yet is not built, and an atom not built tells no one of a change.
  pageRegistry.subscribe(kept, () => setChanges((n) => n + 1), { immediate: true });
  return {
    get: () => {
      changes();
      return pageRegistry.get(kept);
    },
    set: (value) => pageRegistry.set(kept, value),
    update: (change) => pageRegistry.update(kept, change),
    subscribe: (changed) => pageRegistry.subscribe(kept, changed),
  };
}

/** A value of the page's that lasts until it closes (a dialog the shell and a page both open, the farm's overlays). */
export const defineAtom = <A>(initial: A): PageAtom<A> => onPage(Atom.make(initial));

/**
 * A choice held in the address (`?name=value`), so a reload or a link shown to someone opens on it: read while the
 * component lives, read again from the address when it comes back. The address changes a moment after the last set,
 * as a new entry, so back undoes it.
 */
export function useSearchParam(name: string): [Accessor<string>, (value: string) => void] {
  const atom = searchParams(name);
  return [useAtom(atom, pageRegistry), (value) => pageRegistry.set(atom, value)];
}

const searchParams = Atom.family((name: string) => Atom.searchParam(name));

export const framesSource: Atom.Writable<FramesSource> = Atom.keepAlive(Atom.make<FramesSource>(frames));

/** Whether the state stream is up now, read from its source: reading framesAtom here would open and close the stream. */
export const linkIn = (registry: AtomRegistry.AtomRegistry): Link => registry.get(framesSource).get().link;

/** The state stream as an atom: subscribed to its source while anything reads it, so the stream stays open meanwhile. */
export const framesAtom: Atom.Atom<Frames> = Atom.readable((get) => {
  const source = get(framesSource);
  get.addFinalizer(source.subscribe(() => get.setSelf(source.get())));
  return source.get();
});

export type Answer<T> = { readonly state: "waiting" } | { readonly state: "done"; readonly value: T } | { readonly state: "failed"; readonly reason: string };

interface Reader<K> {
  /** Reads after the wait; undefined reads nothing and tells undefined. Any answer to an earlier ask is dropped. */
  readonly request: (key: K | undefined) => void;
  /** Drops whatever is on its way. */
  readonly stop: () => void;
}

/**
 * The answer to the newest ask only, a failure told as a failure rather than "nothing found".
 *
 * A read is asked again as the owner types (a search) or as the place changes (a channel's pins): an answer to an older
 * ask may come last and would otherwise put what was asked before back on screen. Framework-free, for the test: `told`
 * hears each state of the newest ask only.
 */
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
