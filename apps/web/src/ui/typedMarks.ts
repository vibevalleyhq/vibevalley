import { type Mark, typedMarks } from "#/base/typedMarks.ts";

/** Reads the marks an input method just typed into the field as its syntax (base/typedMarks.ts), the way typing them
 * would: the field gets an input of its own, so its handler sees the new text. Gives
 * whether it did, so the handler of the input that typed them can leave the rest to the next one. */
export function typeMarks(el: HTMLTextAreaElement | HTMLInputElement, marks: readonly Mark[]): boolean {
  const at = el.selectionStart;
  if (at === null || at !== el.selectionEnd) return false;
  const m = typedMarks(el.value, at, marks);
  if (!m) return false;
  el.setRangeText(m.text, m.from, m.to, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
