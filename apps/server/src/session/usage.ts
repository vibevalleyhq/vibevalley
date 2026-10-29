import { list, maybe, t } from "@vibevalley/i18n";
import type { EventTokens } from "@vibevalley/protocol";
// What one request of an in-process agent cost, in words for its log.

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
  let text =
    prompt > 0
      ? t("server.session.usage.cached", {
          percent: Math.trunc((tokens.cacheRead * 100) / prompt),
          read: digits(tokens.cacheRead),
          missed: digits(tokens.input),
          output: digits(tokens.output),
        })
      : t("server.session.usage.unread", { output: digits(tokens.output) });
  // As the brain's prefix_changed names the parts.
  if (changed.length > 0) text += t("server.session.usage.changed", { parts: list(changed.map((n) => maybe(`server.session.usage.parts.${n}`) ?? n)) });
  return text;
}
