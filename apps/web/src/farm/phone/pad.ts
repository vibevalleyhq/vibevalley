// The phone's game pad: a cross and A, B under the screen, and the keys that stand for them. The game on screen takes
// them through `usePad`; its keys are caught on the window's capture phase, before the farm's own
// (tools, Esc), while it is up.

import { type Accessor, createEffect, onSettled } from "solid-js";

import { defineAtom } from "#/state/atom.ts";

export type PadButton = "left" | "right" | "up" | "down" | "a" | "b";

export type PadHandler = (button: PadButton, down: boolean) => void;

/** The keys that stand for the pad's buttons. */
const padKeys: Readonly<Record<string, PadButton>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  " ": "a",
  z: "a",
  Z: "a",
  x: "b",
  X: "b",
  Enter: "a",
};

/** Typing in a field: its keys are not the pad's. */
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

// The phone's pad: which game has it, and its keys while it does.
let current: PadHandler | undefined;
const padHeld = defineAtom(false);
const tellPad = () => padHeld.set(current !== undefined);

export const pressPad = (button: PadButton, down: boolean) => current?.(button, down);

/** Whether a game has the pad: the keys under the screen dim when none does. */
export const padListening = (): Accessor<boolean> => padHeld.get;

/** Hands the pad and its keys to `handler` while the calling game is mounted. */
export function usePad(handler: PadHandler) {
  onSettled(() => {
    current = handler;
    tellPad();
    const key = (down: boolean) => (e: KeyboardEvent) => {
      const button = padKeys[e.key];
      if (!button || typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      // A held A, B or up does not repeat (a jump, a slam, a turn per press); held arrows the other ways do.
      if (down && e.repeat && (button === "a" || button === "b" || button === "up")) return;
      handler(button, down);
    };
    const onDown = key(true);
    const onUp = key(false);
    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    return () => {
      if (current === handler) {
        current = undefined;
        tellPad();
      }
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
    };
  });
}

/** Runs `tick(ms)` every animation frame while `on`, with the milliseconds since the last. */
export function useTicks(on: Accessor<boolean>, tick: (ms: number) => void) {
  createEffect(on, (running) => {
    if (!running) return;
    let last = performance.now();
    let id = requestAnimationFrame(function frame(now) {
      tick(now - last);
      last = now;
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  });
}

/** A value kept for this page's life: a game in progress and the best score survive putting the phone away. */
export function kept<T>(initial: T) {
  const value = defineAtom(initial);
  return { get: value.get, set: value.set, use: (): [Accessor<T>, (next: T) => void] => [value.get, value.set] };
}
