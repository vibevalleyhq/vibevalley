// The workbench's toasts as a store of their own, framework-free: ToastHost draws them, and any code adds to the list.

export type Tone = "info" | "bad";

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: Tone;
}

let list: readonly Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** A line at the bottom for four seconds: what happened, or why it did not. */
export function toast(text: string, tone: Tone = "info") {
  const id = Date.now() + Math.random();
  list = [...list, { id, text, tone }];
  emit();
  setTimeout(() => {
    list = list.filter((t) => t.id !== id);
    emit();
  }, 4000);
}

export const toasts = {
  get: () => list,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
