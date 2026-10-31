// Timers that end with the component or scope that set them: a page left open for days keeps no timer of a part that
// is gone, and a timer set again replaces the one before.

import { onCleanup, onSettled } from "solid-js";

/** fn every ms for as long as the owner lives. */
export function useInterval(fn: () => void, ms: number) {
  onSettled(() => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  });
}

/** A timeout to set from a handler: setting it again replaces the one waiting, and the owner's end clears it. */
export function useTimeout(): (fn: () => void, ms: number) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(t));
  return (fn, ms) => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
