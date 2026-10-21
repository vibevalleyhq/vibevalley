// The phone's game pad: a cross and A, B under the screen, and the keys that stand for them.
// The game on screen takes them through `usePad`; its keys are caught on the window's capture phase, before the farm's
// own (tools, Esc), while it is up.

import { useEffect, useRef, useSyncExternalStore } from "react";

export type PadButton = "left" | "right" | "up" | "down" | "a" | "b";

export type PadHandler = (button: PadButton, down: boolean) => void;

const keys: Readonly<Record<string, PadButton>> = {
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

let current: PadHandler | undefined;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

export const pressPad = (button: PadButton, down: boolean) => current?.(button, down);

/** Whether a game has the pad: the keys under the screen dim when none does. */
export const usePadListening = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current !== undefined,
  );

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Hands the pad and its keys to `handler` while the calling game is mounted. */
export function usePad(handler: PadHandler) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const route: PadHandler = (b, d) => latest.current(b, d);
    current = route;
    tell();
    const key = (down: boolean) => (e: KeyboardEvent) => {
      const button = keys[e.key];
      if (!button || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      // A held A, B or up does not repeat (a jump, a slam, a turn per press); held arrows the other ways do.
      if (down && e.repeat && (button === "a" || button === "b" || button === "up")) return;
      route(button, down);
    };
    const onDown = key(true);
    const onUp = key(false);
    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    return () => {
      if (current === route) {
        current = undefined;
        tell();
      }
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
    };
  }, []);
}

/** Runs `tick(ms)` every animation frame while `on`, with the milliseconds since the last. */
export function useTicks(on: boolean, tick: (ms: number) => void) {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  });
  useEffect(() => {
    if (!on) return;
    let last = performance.now();
    let id = requestAnimationFrame(function frame(now) {
      latest.current(now - last);
      last = now;
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  }, [on]);
}

/** A value kept for this page's life (Dart's Kept): a game in progress and the best score survive putting the phone away. */
export function kept<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  const set = (next: T) => {
    value = next;
    subs.forEach((l) => l());
  };
  const use = (): [T, (next: T) => void] => [
    useSyncExternalStore(
      (l) => (subs.add(l), () => subs.delete(l)),
      () => value,
    ),
    set,
  ];
  return { get: () => value, set, use };
}
