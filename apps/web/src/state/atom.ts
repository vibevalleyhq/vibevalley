import { Atom, AtomRegistry } from "effect/reactivity";
import { type Accessor, createContext, createEffect, createSignal, useContext } from "solid-js";

import { createExternal } from "#/base/external.ts";
import { reasonOf } from "#/infra/api.ts";
import { type Frames, frames, type FramesSource, type Link } from "#/infra/frame.ts";

export const createRegistry = (): AtomRegistry.AtomRegistry => AtomRegistry.make();

/** The page's one registry. */
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

type Registry = ReturnType<typeof createRegistry>;

/** A value the page keeps for its life, in the page's registry (or an isolated `RegistryContext`): one way for a feature to keep what is not a component's. */
export interface PageAtom<A> {
  /** The value now; a computation or a component that reads it follows the active `RegistryContext` and runs again when it changes. */
  readonly get: () => A;
  readonly set: (value: A) => void;
  readonly update: (change: (value: A) => A) => void;
  /** Hears every change, for code outside Solid (the canvas, the sounds, another store). */
  readonly subscribe: (changed: () => void) => () => void;
  /** The same atom bound to a specific registry instead of `pageRegistry`. */
  readonly inRegistry: (registry: Registry) => PageAtom<A>;
}

/** The atom held for the registry's life, built and subscribed lazily on first access rather than at module import. */
export function onPage<A>(atom: Atom.Writable<A>): PageAtom<A> {
  const kept = Atom.keepAlive(atom);
  const signals = new WeakMap<Registry, Accessor<number>>();
  const handles = new WeakMap<Registry, PageAtom<A>>();
  const track = (registry: Registry): Accessor<number> => {
    const existing = signals.get(registry);
    if (existing !== undefined) return existing;
    const [changes, setChanges] = createSignal(0);
    // At once: a node not read yet is not built, and an atom not built tells no one of a change.
    registry.subscribe(kept, () => setChanges((n) => n + 1), { immediate: true });
    signals.set(registry, changes);
    return changes;
  };
  const inRegistry = (registry: Registry): PageAtom<A> => {
    const existing = handles.get(registry);
    if (existing !== undefined) return existing;
    const handle: PageAtom<A> = {
      get: () => {
        track(registry)();
        return registry.get(kept);
      },
      set: (value) => {
        track(registry);
        registry.set(kept, value);
      },
      update: (change) => {
        track(registry);
        registry.update(kept, change);
      },
      subscribe: (changed) => registry.subscribe(kept, changed),
      inRegistry,
    };
    handles.set(registry, handle);
    return handle;
  };
  const page: PageAtom<A> = {
    get: () => {
      const active = useContext(RegistryContext);
      track(active)();
      return active.get(kept);
    },
    set: (value) => {
      track(pageRegistry);
      pageRegistry.set(kept, value);
    },
    update: (change) => {
      track(pageRegistry);
      pageRegistry.update(kept, change);
    },
    subscribe: (changed) => pageRegistry.subscribe(kept, changed),
    inRegistry,
  };
  handles.set(pageRegistry, page);
  return page;
}

/** Binds a page atom's reads and writes to the active `RegistryContext`, for component callbacks in tests and stories. */
export function usePageAtom<A>(atom: PageAtom<A>): PageAtom<A> {
  const registry = useRegistry();
  return registry === pageRegistry ? atom : atom.inRegistry(registry);
}

/** A value of the page's that lasts until it closes (a dialog the shell and a page both open, the farm's overlays). */
export const defineAtom = <A>(initial: A): PageAtom<A> => onPage(Atom.make(initial));

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
  /** Reads after the wait. undefined reads nothing and tells undefined. */
  readonly request: (key: K | undefined) => void;
  /** Drops whatever is on its way. */
  readonly stop: () => void;
}

/** The answer to the newest ask only, a failure told as a failure rather than "nothing found". */
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
