// The phone's game pad: a cross and A, B under the screen, and the keys that stand for them. The game on screen takes
// them through `usePad` (farm/support.ts); its keys are caught on the window's capture phase, before the farm's own
// (tools, Esc), while it is up.

export type PadButton = "left" | "right" | "up" | "down" | "a" | "b";

export type PadHandler = (button: PadButton, down: boolean) => void;

/** The keys that stand for the pad's buttons. */
export const padKeys: Readonly<Record<string, PadButton>> = {
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
export const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
