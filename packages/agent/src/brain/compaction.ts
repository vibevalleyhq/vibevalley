import { complete, type ModelClient } from "@vibevalley/ai/client";
import type { ToolDeclaration, Usage } from "@vibevalley/ai/messages";

import { type BrainMessage, type CompactionSummaryMessage, messageText, requestContext, transcript } from "../base/messages.ts";
import { compaction as compactionWords } from "../base/prompts.ts";
import type { AgentFs } from "../infra/fs.ts";
import type { AgentLog } from "../infra/log.ts";
import { archive } from "../tools/memory.ts";
import { applySummary } from "./session.ts";

/** Characters over three: close enough for mixed Chinese and code. */
export const estimateTokens = (messages: readonly BrainMessage[]) => Math.ceil(JSON.stringify(messages).length / 3);

export const summaryInstructions = compactionWords.summaryInstructions;

export const summaryInPlace = compactionWords.summaryInPlace;

const spoke = (m: BrainMessage) => m.role === "assistant" && messageText(m).trim() !== "";
const opens = (m: BrainMessage | undefined) => m?.role === "user" || m?.role === "custom";

/** Where a user's (or custom) message begins, at least keepRecent messages from the end, and further back until at least keepSaid assistant messages with words in them follow. */
export function cutPoint(messages: readonly BrainMessage[], keepRecent: number, keepSaid: number): number {
  let cut = messages.length - keepRecent;
  let said = messages.slice(Math.max(cut, 0)).filter(spoke).length;
  while (cut > 0 && (cut >= messages.length || !opens(messages[cut]) || said < keepSaid)) {
    cut--;
    const m = messages[cut];
    if (m && spoke(m)) said++;
  }
  return Math.max(cut, 0);
}

export interface CompactionOptions {
  readonly home: string;
  readonly session: string;
  readonly llm: ModelClient;
  readonly budget: number;
  readonly keepRecent: number;
  /** The assistant's last words kept as they were, when that keeps the kept part under half the budget. */
  readonly keepSaid: number;
  /** Written after the summary, as it stands when the fold is made (its open tasks); "" for none. */
  readonly append?: () => Promise<string>;
  /** The brain's Time: the summary's and the asked messages' times, the archive's name. */
  readonly now: () => number;
  readonly fs?: AgentFs;
  readonly log: AgentLog;
}

interface CompactionPlan {
  readonly messages: readonly BrainMessage[];
  readonly cut: number;
  readonly tokens: number;
}

export function planCompaction(
  messages: readonly BrainMessage[],
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
  readonly messages: readonly BrainMessage[];
}

/** A cached summary may be reused while more messages join the kept tail. */
export function applyPlan(plan: CompactionPlan, summary: CompactionSummaryMessage): Compacted {
  const s = { ...summary, kept: plan.messages.length - plan.cut };
  return { summary: s, messages: applySummary(plan.messages, s) };
}

async function summaryOf(plan: CompactionPlan, said: string, where: string, options: CompactionOptions): Promise<CompactionSummaryMessage> {
  let summary = said || compactionWords.noSummary;
  const more = options.append ? await options.append() : "";
  if (more) summary += "\n\n" + more;
  return {
    role: "compactionSummary",
    summary,
    tokensBefore: plan.tokens,
    timestamp: options.now(),
    ...(where ? { archive: where } : {}),
    kept: plan.messages.length - plan.cut,
  };
}

/** Where the folded part is kept word for word; "" when it could not be: the fold goes on without it. */
async function archived(options: CompactionOptions, text: string): Promise<string> {
  try {
    return await archive(options.home, options.session, text, options.now(), options.fs);
  } catch (e) {
    options.log.warn(`agent ${options.session}: cannot archive folded transcript:`, e);
    return "";
  }
}

export interface Summarized {
  readonly summary?: CompactionSummaryMessage;
  readonly usage?: Usage;
}

/** The summary of the whole conversation, asked with the same start (prefix, tools) as its requests, so the cache covers
 * all but the last message. */
export async function compactInPlace(
  plan: CompactionPlan,
  options: CompactionOptions,
  prefix: string,
  tools: readonly ToolDeclaration[],
  signal?: AbortSignal,
): Promise<Summarized> {
  const asked = requestContext(prefix, tools, plan.messages);
  const answer = await complete(
    options.llm,
    { ...asked, messages: [...asked.messages, { role: "user", content: summaryInPlace, timestamp: options.now() }] },
    { toolChoice: "none" },
    signal,
  );
  const said = messageText(answer).trim();
  const called = answer.content.some((c) => c.type === "toolCall");
  if (answer.stopReason === "error" || answer.stopReason === "aborted" || said === "" || called) return compact(plan, options, signal);
  const where = await archived(options, transcript(plan.messages.slice(0, plan.cut)));
  return { summary: await summaryOf(plan, said, where, options), usage: answer.usage };
}

async function compact(plan: CompactionPlan, options: CompactionOptions, signal?: AbortSignal): Promise<Summarized> {
  const text = transcript(plan.messages.slice(0, plan.cut));
  const where = await archived(options, text);
  const answer = await complete(
    options.llm,
    {
      system: summaryInstructions,
      tools: [],
      messages: [{ role: "user", content: text, timestamp: options.now() }],
    },
    {},
    signal,
  );
  const said = answer.stopReason === "error" ? "" : messageText(answer).trim();
  return { summary: await summaryOf(plan, said, where, options), usage: answer.usage };
}
