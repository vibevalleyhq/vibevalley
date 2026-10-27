import { type Accessor, createSignal, onSettled } from "solid-js";

/**
 * A store outside Solid (subscribe, get) as an accessor; it notifies when `get` returns a different value. `always`:
 * notify on every call, for a store that returns the same object each time (a version-counted one, voice/dictation.ts).
 */
export function createExternal<T>(subscribe: (fn: () => void) => () => void, get: () => T, options: { always?: boolean } = {}): Accessor<T> {
  const [value, setValue] = createSignal<T>(get() as Exclude<T, Function>, options.always ? { equals: false } : {});
  onSettled(() => {
    setValue(() => get());
    return subscribe(() => setValue(() => get()));
  });
  return value;
}
