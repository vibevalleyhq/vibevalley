// What one request of an in-process agent cost, in words for its log.

import { sessionWording } from "./words.ts";
import type { EventTokens } from "@vibevalley/protocol";

export const tokensOf = (u: { input: number; cacheRead: number; output: number }): EventTokens => ({
  input: u.input,
  cacheRead: u.cacheRead,
  output: u.output,
});

/** Groups of three digits, split by a space: 41 200. */
export const digits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** changed is a prefix_changed's parts, none when the prompt's start was as before. */
export function usageText(t: EventTokens, changed: readonly string[] = []): string {
  const prompt = t.cacheRead + t.input;
  const w = sessionWording().usage;
  let text =
    prompt > 0 ? w.cached(Math.trunc((t.cacheRead * 100) / prompt), digits(t.cacheRead), digits(t.input), digits(t.output)) : w.unread(digits(t.output));
  // As the brain's prefix_changed names the parts.
  if (changed.length > 0) text += w.changed(changed.map((n) => w.parts[n] ?? n));
  return text;
}
