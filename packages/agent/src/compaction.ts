// Past its budget the older part of the conversation is folded into a summary. The older part is cut where a user's
// message begins, so a tool call and its result stay together.

import { Effect } from "effect";

import { complete, type ModelClient } from "@vibevalley/ai/client";
import type { ToolDeclaration, Usage } from "@vibevalley/ai/messages";

import { archive } from "./memory.ts";
import { type BrainMessage, type CompactionSummaryMessage, messageText, requestContext, transcript } from "./messages.ts";
import { compaction as compactionWords } from "./prompts.ts";
import { applySummary } from "./session.ts";

/** Characters over three: close enough for mixed Chinese and code. */
export const estimateTokens = (messages: readonly BrainMessage[]) => Math.ceil(JSON.stringify(messages).length / 3);

export const summaryInstructions = compactionWords.summaryInstructions;

export const summaryInPlace = compactionWords.summaryInPlace;

const spoke = (m: BrainMessage) => m.role === "assistant" && messageText(m).trim() !== "";
const opens = (m: BrainMessage | undefined) => m?.role === "user" || m?.role === "custom";

/** Where a user's (or custom) message begins, at least keepRecent messages from the end, and further back until at least
 * keepSaid assistant messages with words in them follow; 0 for nowhere. */
export function cutPoint(messages: readonly BrainMessage[], keepRecent: number, keepSaid: number): number {
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
  readonly llm: ModelClient;
  readonly budget: number;
  readonly keepRecent: number;
  /** The assistant's last words kept as they were, when that keeps the kept part under half the budget. */
  readonly keepSaid: number;
  /** Written after the summary, as it stands when the fold is made (its open tasks); "" for none. */
  readonly append?: () => Effect.Effect<string>;
  /** The brain's Time: the summary's and the asked messages' times, the archive's name. */
  readonly now: () => number;
}

export interface CompactionPlan {
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

const summaryOf = (plan: CompactionPlan, said: string, where: string, options: CompactionOptions) =>
  Effect.gen(function* () {
    let summary = said || compactionWords.noSummary;
    const more = options.append ? yield* options.append() : "";
    if (more) summary += "\n\n" + more;
    const message: CompactionSummaryMessage = {
      role: "compactionSummary",
      summary,
      tokensBefore: plan.tokens,
      timestamp: options.now(),
      ...(where ? { archive: where } : {}),
      kept: plan.messages.length - plan.cut,
    };
    return message;
  });

function archived(options: CompactionOptions, text: string): string {
  try {
    return archive(options.home, options.session, text, new Date(options.now()));
  } catch {
    return "";
  }
}

export interface Summarized {
  readonly summary?: CompactionSummaryMessage;
  readonly usage?: Usage;
}

/** The summary of the whole conversation, asked with the same start (prefix, tools) as its requests, so the cache covers
 * all but the last message. */
export const compactInPlace = (plan: CompactionPlan, options: CompactionOptions, prefix: string, tools: readonly ToolDeclaration[]) =>
  Effect.gen(function* () {
    const asked = requestContext(prefix, tools, plan.messages);
    const answer = yield* complete(
      options.llm,
      { ...asked, messages: [...asked.messages, { role: "user", content: summaryInPlace, timestamp: options.now() }] },
      { toolChoice: "none" },
    );
    const said = messageText(answer).trim();
    const called = answer.content.some((c) => c.type === "toolCall");
    if (answer.stopReason === "error" || answer.stopReason === "aborted" || said === "" || called) return yield* compact(plan, options);
    const where = archived(options, transcript(plan.messages.slice(0, plan.cut)));
    const summarized: Summarized = { summary: yield* summaryOf(plan, said, where, options), usage: answer.usage };
    return summarized;
  });

const compact = (plan: CompactionPlan, options: CompactionOptions) =>
  Effect.gen(function* () {
    const text = transcript(plan.messages.slice(0, plan.cut));
    const where = archived(options, text);
    const answer = yield* complete(options.llm, {
      system: summaryInstructions,
      tools: [],
      messages: [{ role: "user", content: text, timestamp: options.now() }],
    });
    const said = answer.stopReason === "error" ? "" : messageText(answer).trim();
    const summarized: Summarized = { summary: yield* summaryOf(plan, said, where, options), usage: answer.usage };
    return summarized;
  });
