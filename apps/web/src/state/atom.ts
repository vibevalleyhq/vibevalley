import { type Accessor, createContext, createEffect, createSignal, getOwner, useContext } from "solid-js";

import { createExternal } from "#/base/external.ts";
import { reasonOf } from "#/infra/api.ts";
import { type Frames, frames, type FramesSource, type Link } from "#/infra/frame.ts";

/** A value kept in a registry: built on its first read there, then held for the registry's life. */
export interface Atom<A> {
  /** The value when first read in a registry; `set` changes it later (another tab's write). */
  readonly init: (set: (value: A) => void) => A;
  /** Runs on each set of a new value in a registry (a stored one writes it down). */
  readonly written?: (value: A) => void;
}

export const atom = <A>(initial: A): Atom<A> => ({ init: () => initial });

interface Node {
  value: unknown;
  readonly listeners: Set<(value: unknown) => void>;
}

/** Where atoms' values live: the page's one, or a test's or a story's own. */
export class Registry {
  readonly #nodes = new Map<Atom<never>, Node>();

  #node<A>(atom: Atom<A>): Node {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the map is keyed by the atom, and each node holds that atom's value
    const key = atom as unknown as Atom<never>;
    const existing = this.#nodes.get(key);
    if (existing) return existing;
    const node: Node = { value: undefined, listeners: new Set() };
    this.#nodes.set(key, node);
    node.value = atom.init((value) => this.#put(node, value));
    return node;
  }

  #put(node: Node, value: unknown): boolean {
    if (Object.is(node.value, value)) return false;
    node.value = value;
    for (const l of [...node.listeners]) l(value);
    return true;
  }

  get<A>(atom: Atom<A>): A {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the node of this atom holds its value
    return this.#node(atom).value as A;
  }

  set<A>(atom: Atom<A>, value: NoInfer<A>): void {
    if (this.#put(this.#node(atom), value)) atom.written?.(value);
  }

  update<A>(atom: Atom<A>, change: (value: NoInfer<A>) => NoInfer<A>): void {
    this.set(atom, change(this.get(atom)));
  }

  /** Hears each new value; `immediate` also tells the value now. */
  subscribe<A>(atom: Atom<A>, listener: (value: A) => void, options: { readonly immediate?: boolean } = {}): () => void {
    const node = this.#node(atom);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the node of this atom only ever holds an A
    const heard = listener as (value: unknown) => void;
    node.listeners.add(heard);
    if (options.immediate === true) heard(node.value);
    return () => void node.listeners.delete(heard);
  }
}

export const createRegistry = (): Registry => new Registry();

/** The page's one registry. */
export const pageRegistry: Registry = createRegistry();

/** Every atom's value lives in one registry for the page; the page's own unless a test or a story gives another. */
export const RegistryContext = createContext<Registry>(pageRegistry);

export const useRegistry = (): Registry => useContext(RegistryContext);

/** An atom's value as an accessor: subscribed while the component lives, never suspending. */
export function useAtom<A>(atom: Atom<A>, registry: Registry = useRegistry()): Accessor<A> {
  return createExternal(
    (changed) => registry.subscribe(atom, changed),
    () => registry.get(atom),
  );
}

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
export function onPage<A>(kept: Atom<A>): PageAtom<A> {
  const signals = new WeakMap<Registry, Accessor<number>>();
  const handles = new WeakMap<Registry, PageAtom<A>>();
  const counted = (registry: Registry): Accessor<number> => {
    // Written from wherever the registry changes, a computation included: the count is a clock, not state the computation owns.
    const [changes, setChanges] = createSignal(0, { ownedWrite: true });
    registry.subscribe(kept, () => setChanges((n) => n + 1));
    return changes;
  };
  const track = (registry: Registry): Accessor<number> => {
    const existing = signals.get(registry);
    if (existing !== undefined) return existing;
    const made = counted(registry);
    signals.set(registry, made);
    return made;
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
      // Outside any owner (a store, a test) there is no context to read: that is the page's registry.
      const active = getOwner() === null ? pageRegistry : useContext(RegistryContext);
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
export const defineAtom = <A>(initial: A): PageAtom<A> => onPage(atom(initial));

export const framesSource: Atom<FramesSource> = atom<FramesSource>(frames);

/** Whether the state stream is up now, read from its source: subscribing would open and close the stream. */
export const linkIn = (registry: Registry): Link => registry.get(framesSource).get().link;

/** The registry's frames now. */
export const framesIn = (registry: Registry): Frames => registry.get(framesSource).get();

/** Hears each frame of the registry's source, and follows the source when a test swaps it; the stream stays open meanwhile. */
export function subscribeFrames(registry: Registry, heard: (frames: Frames) => void): () => void {
  let off = () => {};
  const follow = (source: FramesSource) => {
    off();
    off = source.subscribe(() => heard(source.get()));
  };
  follow(registry.get(framesSource));
  const unswap = registry.subscribe(framesSource, (source) => {
    follow(source);
    heard(source.get());
  });
  return () => {
    unswap();
    off();
  };
}

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
