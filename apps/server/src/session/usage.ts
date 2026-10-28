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
export function usageText(tokens: EventTokens, changed: readonly string[] = []): string {
  const prompt = tokens.cacheRead + tokens.input;
  const w = sessionWording().usage;
  let text =
    prompt > 0
      ? w.cached(Math.trunc((tokens.cacheRead * 100) / prompt), digits(tokens.cacheRead), digits(tokens.input), digits(tokens.output))
      : w.unread(digits(tokens.output));
  // As the brain's prefix_changed names the parts.
  if (changed.length > 0) text += w.changed(changed.map((n) => w.parts[n] ?? n));
  return text;
}
