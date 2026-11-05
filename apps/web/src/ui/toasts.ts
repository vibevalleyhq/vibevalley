import { defineAtom } from "#/state/atom.ts";

export type Tone = "info" | "bad";

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: Tone;
}

export const toasts = defineAtom<readonly Toast[]>([]);

let last = 0;

/** A line at the bottom for four seconds: what happened, or why it did not. */
export function toast(text: string, tone: Tone = "info") {
  const id = ++last;
  toasts.update((list) => [...list, { id, text, tone }]);
  // oxlint-disable-next-line vibevalley/dropped-timer -- the toasts live as long as the page
  setTimeout(() => toasts.update((list) => list.filter((t) => t.id !== id)), 4000);
}
