// Roving focus over a composite's items in the DOM: the arrow keys move the focus among the elements that match `item`
// inside `root`, in document order, passing over disabled ones.

import { moveIndex, type Orientation } from "./composite.ts";

export const itemsIn = (root: HTMLElement, item: string) => [...root.querySelectorAll<HTMLElement>(item)];

export const disabled = (el: HTMLElement) => el.hasAttribute("data-disabled") || (el as HTMLButtonElement).disabled === true;

/** Moves the focus for a key, and says to which item; undefined when the key is not a move. */
export function roveFocus(e: KeyboardEvent, root: HTMLElement, item: string, o: { orientation: Orientation | "both"; loop: boolean }): HTMLElement | undefined {
  const items = itemsIn(root, item);
  const current = items.indexOf(document.activeElement as HTMLElement);
  const at = moveIndex(e.key, current, items.length, { ...o, enabled: (i) => !disabled(items[i]!) });
  if (at === undefined) return undefined;
  e.preventDefault();
  items[at]!.focus();
  return items[at];
}
