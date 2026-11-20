import { cleanup, host, keymap } from "nsh";

import { createEffect, createSignal } from "../../solid";

export type PadButton = "left" | "right" | "up" | "down" | "a" | "b";
type Listener = (button: PadButton, down: boolean) => void;
const keys: Record<string, PadButton> = { left: "left", right: "right", up: "up", down: "down", x: "b", space: "a", enter: "a", z: "a" };
let current: Listener | undefined;

export function press(button: PadButton, down: boolean) {
  current?.(button, down);
}
export function usePad(listen: Listener) {
  current = listen;
  for (const [key, button] of Object.entries(keys)) {
    const repeat = button === "left" || button === "right" || button === "down";
    cleanup(keymap.bind(key, () => listen(button, true), { when: "notEditing", repeat }));
  }
  cleanup(
    host.on("farm-key-up", (key) => {
      if (typeof key !== "string") return;
      const button = keys[key];
      if (button) listen(button, false);
    }),
  );
  cleanup(() => {
    if (current === listen) current = undefined;
  });
}
export function kept<T>(initial: T) {
  const [get, set] = createSignal(initial);
  return { get, use: () => [get, set] as const };
}
export function useTicks(on: () => boolean, tick: (ms: number) => void) {
  createEffect(on, (running) => {
    if (!running) return;
    let last: number | undefined;
    let id = requestAnimationFrame(function next(now) {
      if (last !== undefined) tick(now - last);
      last = now;
      id = requestAnimationFrame(next);
    });
    return () => cancelAnimationFrame(id);
  });
}
