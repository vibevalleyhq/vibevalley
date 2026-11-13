import type { z } from "zod";

import { type Atom, onPage, type PageAtom } from "./atom";

/** Every key the page keeps starts with this; public/opening.html reads `prefs` under it before any script. */
const storedPrefix = "vibevalley.";

// A storage that cannot be reached (none, a sandboxed frame's, a full one) throws: the choice then lives for the page's life.
function attempt<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** A choice's atom, for a registry of the caller's (the tests); the page's are made by defineStored. */
export function storedAtom<S extends z.ZodType>(name: string, schema: S, fallback: z.output<S>): Atom<z.output<S>> {
  const key = storedPrefix + name;
  const decode = (text: string | undefined): { readonly value: z.output<S> } | undefined => {
    if (typeof text !== "string") return undefined;
    const json = attempt((): unknown => JSON.parse(text));
    if (json === undefined) return undefined;
    const got = schema.safeParse(json);
    return got.success ? { value: got.data } : undefined;
  };
  return {
    init: (set) => {
      // Another tab on this machine wrote it: the storage event comes to every other tab, never to the one that wrote.
      if (typeof window !== "undefined") {
        window.addEventListener("storage", (e: Event) => {
          if (!("key" in e) || e.key !== key || !("newValue" in e) || typeof e.newValue !== "string") return;
          const got = decode(e.newValue);
          if (got) set(got.value);
        });
      }
      return decode(attempt(() => localStorage.getItem(key) ?? undefined))?.value ?? fallback;
    },
    written: (value) => attempt(() => localStorage.setItem(key, JSON.stringify(value))),
  };
}

/** A choice kept on this machine, read and set as the page's value; `name` is unique across the page. */
export const defineStored = <S extends z.ZodType>(name: string, schema: S, fallback: z.output<S>): PageAtom<z.output<S>> =>
  onPage(storedAtom(name, schema, fallback));

/** A field of a stored struct that reads as `fallback` when it is missing or does not decode, so one bad field does not throw away the others. */
export const orFallback = <S extends z.ZodType>(schema: S, fallback: z.output<S>) => schema.catch(fallback);
