import { type Act, createAct } from "#/ui/act.ts";

import { noticeTitle, ToastType, toasts } from "./ToastViewport";

export type Cell = readonly [x: number, y: number];

export const tickCells: readonly Cell[] = [
  [6, 1],
  [5, 2],
  [4, 3],
  [0, 3],
  [1, 4],
  [3, 4],
  [2, 5],
];

export const crossCells: readonly Cell[] = [
  [1, 1],
  [5, 1],
  [2, 2],
  [4, 2],
  [3, 3],
  [2, 4],
  [4, 4],
  [1, 5],
  [5, 5],
];

/** ui/act.ts's createAct for the pixel skins: a refusal is a pixel toast in the error type, under `title` when given. */
export function createPixelAct(title?: string): Act {
  return createAct((reason) => toasts.add({ type: ToastType.error, title: title ?? noticeTitle.error ?? reason, description: reason }));
}

/** What a draft adds to `chips`: split at , and ，, trimmed, without empties or repeats. */
export function splitChips(draft: string, chips: readonly string[]): string[] {
  const parts: string[] = [];
  for (const p of draft.split(/[,，]/u)) {
    const t = p.trim();
    if (t && !chips.includes(t) && !parts.includes(t)) parts.push(t);
  }
  return parts;
}

export interface PickOption {
  value: string;
  label: string;
  detail?: string;
}

/** What a pick lists: with `clearable`, no value is a choice of its own, listed first as the placeholder. */
export function pickItems(options: readonly PickOption[], placeholder: string, clearable: boolean): PickOption[] {
  return [...(clearable ? [{ value: "", label: placeholder }] : []), ...options.filter((o) => o.value !== "")];
}
