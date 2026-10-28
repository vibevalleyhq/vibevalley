import { t } from "@vibevalley/i18n";
// The orchestrator's pure rules: where an input came from, how the farm reads to it and what changed
// in it, what the patrol finds, and how a model answer's tokens are worded.

import { lineWords, quotaWords, situationWords, sourceHead } from "./prompts.ts";
import { ownerId, type RunTriggerKind, type RuntimeInfo } from "@vibevalley/protocol";
import { head } from "../base/text.ts";
import { type InboxMessage } from "../channel/rules.ts";
import { messageLine } from "../channel/prompts.ts";
import { quotaLow, yuan } from "../runtime/money.ts";

/** The model the orchestrator answers as on the OpenAI chat/completions protocol: on the voice line and on the farm's own chatCompletionsPath. */
export const orchestratorModel = "vibevalley-orchestrator";
export const chatCompletionsPath = "/v1/chat/completions";

/** Who woke the orchestrator: what the input's words are worth. */
export type Source =
  /** The owner's words alone: in a channel, on a call, over chat/completions, from a connector. */
  | "owner"
  /** A channel or a thread with a helper's words in it. */
  | "chat"
  | "issue"
  | "recurrence"
  | "patrol"
  | "graph";

/** How an input of each source goes in. head: its first words, fixed per source so that the conversation's prefix stays
 * the same, and how its log names the round. now: it joins the run under way (the owner waits on it); else it waits until
 * the run would stop. trigger: what its run is started by, unless the input brings its own. */
export const intake: Readonly<Record<Source, { readonly head: string; readonly now: boolean; readonly trigger: RunTriggerKind }>> = {
  owner: { head: sourceHead.owner, now: true, trigger: "comment" },
  chat: { head: sourceHead.chat, now: false, trigger: "comment" },
  issue: { head: sourceHead.issue, now: false, trigger: "issue" },
  recurrence: { head: sourceHead.recurrence, now: false, trigger: "recurrence" },
  // The patrol's and the task graphs' lines are the farm's own.
  patrol: { head: sourceHead.patrol, now: false, trigger: "runtime" },
  graph: { head: sourceHead.graph, now: false, trigger: "runtime" },
};

export function quotaText(info: RuntimeInfo | undefined): string {
  const budget = info?.settings.dailyBudget ?? 0;
  const spentToday = info?.spentToday;
  const low = info?.quota?.left !== undefined && info.quota.left !== null && info.quota.left < quotaLow ? quotaWords.low : "";
  let today = "";
  if (spentToday !== undefined || budget > 0) {
    today = quotaWords.today(yuan(spentToday ?? 0));
    if (budget > 0) today += quotaWords.budget(yuan(budget));
  }
  return quotaWords.line(info?.quota?.text, low, today);
}

/** The orchestrator answers only on DeepSeek: its profile's model as DeepSeek names it. */
export function deepseekModel(configured: string, fallback: string): string {
  if (configured === "") return fallback;
  const slash = configured.indexOf("/");
  if (slash < 0) return configured;
  if (configured.slice(0, slash) === "deepseek") return configured.slice(slash + 1);
  throw new Error(t("server.orchestrator.onlyDeepseek", { configured }));
}

interface SituationLine {
  readonly head: string;
  readonly line: string;
}

/** An item ("- …", or indented) is known by the head above it too: the same "（没有帮工）" under two channels is two lines. */
function situationLines(text: string): SituationLine[] {
  const out: SituationLine[] = [];
  let at = "";
  for (const l of text.split("\n")) {
    if (l.startsWith("- ") || l.startsWith(" ")) {
      out.push({ head: at, line: l });
      continue;
    }
    at = l;
    out.push({ head: "", line: l });
  }
  return out;
}

const has = (lines: readonly SituationLine[], l: SituationLine) => lines.some((x) => x.head === l.head && x.line === l.line);

/** What changed from before to now, line by line: + for a line now has and before had not, − for one gone, each item after
 * the head it is under. The whole of now when more than half its lines changed, where a list of changes reads worse than
 * the thing; "" when nothing did. */
export function situationDelta(before: string, now: string): string {
  const was = situationLines(before);
  const is = situationLines(now);
  const changes = [...is.filter((l) => !has(was, l)).map((l) => ({ ...l, mark: "+ " })), ...was.filter((l) => !has(is, l)).map((l) => ({ ...l, mark: "− " }))];
  if (changes.length === 0) return "";
  if (changes.length * 2 > is.length) return now;
  const out = [situationWords.changed];
  let at = "";
  for (const c of changes) {
    if (c.head === "") at = c.line;
    else if (c.head !== at) {
      out.push(c.head);
      at = c.head;
    }
    out.push(c.mark + c.line);
  }
  return out.join("\n");
}

/** In UTF-16 units: enough for a report's conclusion; the rest stays in the chat for channel_message_list. */
export const lineMax = 800;

/** As inboxLines, but what others said past lineMax is cut, with where to read it whole. The owner's words stay whole. */
export const orchestratorInboxLines = (messages: readonly InboxMessage[]) =>
  messages
    .map((m) => {
      const text = m.text.trim();
      return messageLine(m.from !== ownerId && text.length > lineMax ? { ...m, text: head(text, lineMax) + lineWords.cut(text.length, m.target) } : m);
    })
    .join("\n");
