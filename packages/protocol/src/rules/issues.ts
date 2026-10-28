// An issue's title in one short line, and its state in words, as the board, the phone, the tools and the orchestrator say them.

import type { Issue } from "../shapes";
import { wording } from "../words";

const titleMax = 40;

/** One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits;
 * failing those, cut. Lengths are characters. */
export function shortTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const chars = [...line];
  if (chars.length <= titleMax) return line;
  const head = chars.slice(0, titleMax + 1).join("");
  const sentence = /^(.{4,}?)[。！？!?；;]/u.exec(head)?.[1];
  if (sentence) return sentence.trim();
  const pause = Math.max(...[..."：:，,、"].map((p) => head.lastIndexOf(p)));
  if (pause >= 4) return head.slice(0, pause).trim();
  return chars.slice(0, titleMax - 1).join("") + "…";
}

/** What its close says: done with what it delivered, or canceled and why. */
export const closedText = (pick: Pick<Issue, "status" | "delivered" | "canceled">): string => {
  const w = wording();
  return pick.delivered ? w.doneWith(w.delivered[pick.delivered]) : pick.canceled ? w.canceledFor(w.canceled[pick.canceled]) : w.status[pick.status];
};
