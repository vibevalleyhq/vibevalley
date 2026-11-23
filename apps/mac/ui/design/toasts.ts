import { signal } from "nsh";

export type Tone = "info" | "bad";

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: Tone;
}

const list = signal<readonly Toast[]>([]);

export const toasts = {
  get: (): readonly Toast[] => list(),
  update: (fn: (prev: readonly Toast[]) => readonly Toast[]): void => {
    list.set(fn(list()));
  },
};

let last = 0;

/** A line at the bottom for four seconds: what happened, or why it did not. */
export function toast(text: string, tone: Tone = "info") {
  const id = ++last;
  toasts.update((items) => [...items, { id, text, tone }]);
  setTimeout(() => toasts.update((items) => items.filter((t) => t.id !== id)), 4000);
}
