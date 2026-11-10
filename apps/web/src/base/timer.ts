import { onCleanup, onSettled } from "solid-js";

/** fn every ms for as long as the reactive owner lives. */
export function useInterval(fn: () => void, ms: number) {
  onSettled(() => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  });
}

/** A timeout to set from a handler: setting it again replaces the one waiting, and the reactive owner's end clears it. */
export function useTimeout(): (fn: () => void, ms: number) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(t));
  return (fn, ms) => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
