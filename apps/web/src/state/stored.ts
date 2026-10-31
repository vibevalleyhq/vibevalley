// This machine's choices, kept in the browser's storage under one namespace (vibevalley.<name>), each through a Schema.
// The only door to localStorage on the page (lint vibevalley/stored-door): a value that does not decode (an older page
// wrote it, or a hand did) reads as its fallback, and a storage that throws (a private window, a full one, a sandboxed
// frame) leaves the choice for this page's life. Every reader in the page hears a change, and so does every other tab.

import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Atom } from "effect/reactivity";

import { onPage, type PageAtom } from "./atom";

/** Every key the page keeps starts with this; public/opening.html reads `prefs` under it before any script. */
const storedPrefix = "vibevalley.";

// Built once per registry, when the first stored atom is read: a storage that cannot be reached fails the layer, and
// every stored atom then reads its fallback.
const storage = Atom.runtime(KeyValueStore.layerStorage(() => localStorage));

/** A choice's atom, for a registry of the caller's (the tests); the page's are made by defineStored. */
export function storedAtom<S extends Schema.Codec<unknown, unknown>>(name: string, schema: S, fallback: S["Type"]): Atom.Writable<S["Type"]> {
  const key = storedPrefix + name;
  const inner = Atom.kvs({ runtime: storage, key, schema, defaultValue: () => fallback });
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.toCodecJson(schema)));
  return Atom.writable(
    (get) => {
      // Another tab on this machine wrote it: the storage event comes to every other tab, never to the one that wrote.
      if (typeof window !== "undefined") {
        const heard = (e: Event) => {
          if (!("key" in e) || e.key !== key || !("newValue" in e) || typeof e.newValue !== "string") return;
          const value = decode(e.newValue);
          if (Option.isSome(value)) get.set(inner, value.value);
        };
        const tab = window;
        tab.addEventListener("storage", heard);
        get.addFinalizer(() => tab.removeEventListener("storage", heard));
      }
      return get(inner);
    },
    (ctx, value: S["Type"]) => ctx.set(inner, value),
  );
}

/** A choice kept on this machine, read and set as the page's value; `name` is unique across the page. */
export const defineStored = <S extends Schema.Codec<unknown, unknown>>(name: string, schema: S, fallback: S["Type"]): PageAtom<S["Type"]> =>
  onPage(storedAtom(name, schema, fallback));

/**
 * A field of a stored struct that reads as `fallback` when it is missing or does not decode, so one bad field does not
 * throw away the others (the prefs, written partly by a test or an older page).
 */
export function orFallback<S extends Schema.Top>(schema: S, fallback: S["Type"]) {
  const tolerant = Schema.catchDecoding<S>(() => Effect.succeedSome(fallback))(schema);
  return Schema.withDecodingDefaultTypeKey<typeof tolerant>(Effect.succeed(fallback))(tolerant);
}
