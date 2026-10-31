// The page's middle layer stands on Effect's Atom (effect/reactivity). Its API is marked unstable, so only base/ imports it
// (lint vibevalley/atom-door): a change in it is fixed here and in intent.ts, and features read atoms through what these
// files export. Effect's own Solid binding (@effect/atom-solid) wants solid-js 1, and its reads suspend; this one is a
// subscription read as a signal (createExternal), so a value an atom has not got yet never holds up the state frames.

import { Atom, AtomRegistry } from "effect/reactivity";
import { type Accessor, createContext, useContext } from "solid-js";

import { createExternal } from "./external";
import { type Frames, frames } from "./frames";

/** Every atom's value lives in one registry for the page, given at Root (stories and tests make their own). */
export const RegistryContext = createContext<AtomRegistry.AtomRegistry>();

export const createRegistry = (): AtomRegistry.AtomRegistry => AtomRegistry.make();

export const useRegistry = (): AtomRegistry.AtomRegistry => useContext(RegistryContext);

/** An atom's value as an accessor: subscribed while the component lives, never suspending. */
export function useAtom<A>(atom: Atom.Atom<A>, registry: AtomRegistry.AtomRegistry = useRegistry()): Accessor<A> {
  return createExternal(
    (changed) => registry.subscribe(atom, changed),
    () => registry.get(atom),
  );
}

/** Where the frames come from, as base/frames.ts gives them; a test sets a source of its own in its registry. */
export interface FramesSource {
  readonly get: () => Frames;
  readonly subscribe: (listener: () => void) => () => void;
}

export const framesSource: Atom.Writable<FramesSource> = Atom.keepAlive(Atom.make<FramesSource>(frames));

/** The state stream as an atom: subscribed to its source while anything reads it, so the stream stays open meanwhile. */
export const framesAtom: Atom.Atom<Frames> = Atom.readable((get) => {
  const source = get(framesSource);
  get.addFinalizer(source.subscribe(() => get.setSelf(source.get())));
  return source.get();
});
