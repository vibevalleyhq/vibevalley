// What one request of an in-process agent cost, in words for its log.

import type { EventTokens } from "@vibevalley/protocol";

/** As the brain's prefix_changed names the parts. */
const prefixParts: Record<string, string> = {
  instructions: "说明",
  env: "环境",
  skills: "技能",
  memory: "记性",
  tools: "工具",
};

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
  let text =
    prompt > 0
      ? `缓存命中 ${Math.trunc((t.cacheRead * 100) / prompt)}%：读缓存 ${digits(t.cacheRead)}，没命中 ${digits(t.input)}，输出 ${digits(t.output)}`
      : "没报读了多少：输出 " + digits(t.output);
  if (changed.length > 0) text += "；开头变了：" + changed.map((n) => prefixParts[n] ?? n).join("、");
  return text;
}
