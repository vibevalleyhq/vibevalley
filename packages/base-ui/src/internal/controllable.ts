import { createSignal } from "solid-js";

/**
 * A value the caller owns when it gives one (`value()` is not undefined) and the component keeps otherwise, starting at
 * `initial`. Setting it tells `onChange` either way: that is how an owner hears of it.
 */
export function createControllable<T>(o: { value: () => T | undefined; initial: T; onChange?: ((value: T) => void) | undefined }) {
  // Boxed: a T that is itself a function would be read as an updater.
  const [kept, setKept] = createSignal<{ readonly v: T }>({ v: o.initial });
  const get = () => {
    const given = o.value();
    // Only undefined leaves it to the component: a T that may be null (nothing selected) is still the owner's.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- `??` would also hand null over to the component
    return given === undefined ? kept().v : given;
  };
  const set = (next: T) => {
    if (Object.is(next, get())) return;
    if (o.value() === undefined) setKept({ v: next });
    o.onChange?.(next);
  };
  return [get, set] as const;
}
