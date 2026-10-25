// Past its budget the older part of the conversation is folded into a summary. The older part is cut where a user's
// message begins, so a tool call and its result stay together.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool, Usage } from "@earendil-works/pi-ai";
import { complete, type LLM } from "./config.ts";
import { archive } from "./memory.ts";
import { type CompactionSummaryMessage, messageText, transcript, withPrefix } from "./messages.ts";
import { applySummary } from "./session.ts";

/** Characters over three: close enough for mixed Chinese and code. */
export const estimateTokens = (messages: readonly AgentMessage[]) => Math.ceil(JSON.stringify(messages).length / 3);

export const summaryInstructions =
  "把下面这段对话压成一份摘要，给接下来继续这段对话的你自己看。保留：用户要的是什么、做出的决定、已经完成的事和结果、改过的文件和关键内容、还没做完的事、要注意的坑。去掉寒暄和已经没用的工具输出。用中文，条理清楚，不超过 1500 字。";

export const summaryInPlace =
  "上面的对话要压成一份摘要，给接下来继续这段对话的你自己看；只写摘要，不调工具。保留：用户要的是什么、做出的决定、已经完成的事和结果、改过的文件和关键内容、还没做完的事、要注意的坑。去掉寒暄和已经没用的工具输出。用中文，条理清楚，不超过 1500 字。";

const spoke = (m: AgentMessage) => m.role === "assistant" && messageText(m).trim() !== "";
const opens = (m: AgentMessage | undefined) => m?.role === "user" || m?.role === "custom";

/** Where a user's (or custom) message begins, at least keepRecent messages from the end, and further back until at least
 * keepSaid assistant messages with words in them follow; 0 for nowhere. */
export function cutPoint(messages: readonly AgentMessage[], keepRecent: number, keepSaid: number): number {
  let cut = messages.length - keepRecent;
  let said = messages.slice(Math.max(cut, 0)).filter(spoke).length;
  while (cut > 0 && (cut >= messages.length || !opens(messages[cut]) || said < keepSaid)) {
    cut--;
    if (cut >= 0 && cut < messages.length && spoke(messages[cut]!)) said++;
  }
  return Math.max(cut, 0);
}

export interface CompactionOptions {
  readonly home: string;
  readonly session: string;
  readonly llm: LLM;
  readonly budget: number;
  readonly keepRecent: number;
  /** The assistant's last words kept as they were, when that keeps the kept part under half the budget. */
  readonly keepSaid: number;
  /** Written after the summary, as it stands when the fold is made (the open task graph); "" for none. */
  readonly append?: () => Promise<string>;
}

export interface CompactionPlan {
  readonly messages: readonly AgentMessage[];
  readonly cut: number;
  readonly tokens: number;
}

export function planCompaction(
  messages: readonly AgentMessage[],
  options: Pick<CompactionOptions, "budget" | "keepRecent" | "keepSaid">,
): CompactionPlan | undefined {
  const tokens = estimateTokens(messages);
  if (tokens <= options.budget || messages.length <= options.keepRecent + 2) return undefined;
  let cut = cutPoint(messages, options.keepRecent, options.keepSaid);
  // Keeping the words would keep too much, or all of it: then fold as if they did not count.
  if (cut <= 0 || estimateTokens(messages.slice(cut)) > options.budget / 2) cut = cutPoint(messages, options.keepRecent, 0);
  if (cut <= 0) return undefined;
  return { messages, cut, tokens };
}

export interface Compacted {
  readonly summary: CompactionSummaryMessage;
  readonly messages: AgentMessage[];
}

/** A cached summary may be reused while more messages join the kept tail. */
export function applyPlan(plan: CompactionPlan, summary: CompactionSummaryMessage): Compacted {
  const s = { ...summary, kept: plan.messages.length - plan.cut };
  return { summary: s, messages: applySummary(plan.messages, s) };
}

async function summaryOf(plan: CompactionPlan, said: string, where: string, options: CompactionOptions): Promise<CompactionSummaryMessage> {
  let summary = said || "（摘要没生成出来，原文见归档。）";
  const more = (await options.append?.()) ?? "";
  if (more) summary += "\n\n" + more;
  return {
    role: "compactionSummary",
    summary,
    tokensBefore: plan.tokens,
    timestamp: Date.now(),
    ...(where ? { archive: where } : {}),
    kept: plan.messages.length - plan.cut,
  };
}

function archived(options: CompactionOptions, text: string): string {
  try {
    return archive(options.home, options.session, text);
  } catch {
    return "";
  }
}

export interface Summarized {
  readonly summary?: CompactionSummaryMessage;
  readonly usage?: Usage;
}

/** The summary of the whole conversation, asked after it with the same start (prefix, tools) its requests have, so the
 * cache covers all but the last message; with nothing to call. An answer that failed, is empty or called a tool anyway
 * is asked again on its own (compact). */
export async function compactInPlace(
  plan: CompactionPlan,
  options: CompactionOptions,
  prefix: string,
  tools: readonly Tool[],
  signal?: AbortSignal,
): Promise<Summarized> {
  const messages = [...withPrefix(prefix, tools, plan.messages), { role: "user" as const, content: summaryInPlace, timestamp: Date.now() }];
  const answer = await complete(options.llm, messages, {
    toolChoice: "none",
    ...(signal ? { signal } : {}),
  });
  const said = messageText(answer).trim();
  const called = answer.content.some((c) => c.type === "toolCall");
  if (answer.stopReason === "error" || answer.stopReason === "aborted" || said === "" || called) return compact(plan, options, signal);
  const where = archived(options, transcript(plan.messages.slice(0, plan.cut)));
  return { summary: await summaryOf(plan, said, where, options), usage: answer.usage };
}

async function compact(plan: CompactionPlan, options: CompactionOptions, signal?: AbortSignal): Promise<Summarized> {
  const text = transcript(plan.messages.slice(0, plan.cut));
  const where = archived(options, text);
  const answer = await complete(
    options.llm,
    [
      { role: "system", content: summaryInstructions, timestamp: 0 },
      { role: "user", content: text, timestamp: Date.now() },
    ],
    signal ? { signal } : {},
  );
  const said = answer.stopReason === "error" ? "" : messageText(answer).trim();
  return { summary: await summaryOf(plan, said, where, options), usage: answer.usage };
}
