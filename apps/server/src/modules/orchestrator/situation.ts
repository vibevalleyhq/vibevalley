import { t } from "@vibevalley/i18n";
import { userId, quotaLow, type RunTrigger, type RuntimeInfo } from "@vibevalley/protocol";

import { head } from "#/base/clip.ts";
import { yuan } from "#/modules/agent/quota.ts";
import { type Envelope } from "#/modules/session/envelope.ts";
import { messageLine } from "#/modules/session/prompts.ts";

import { lineWords, quotaWords, situationWords, sourceHead } from "./prompts.ts";

/** Who woke the orchestrator: what the input's words are worth. */
export type Source =
  /** The user's words alone: in a channel, on a call, over chat/completions, from a connector. */
  | "user"
  /** A channel or a thread with a helper's words in it. */
  | "chat"
  | "issue"
  | "cron"
  | "patrol";

/** How an input of each source goes in. */
export const intake: Readonly<Record<Source, { readonly head: string; readonly now: boolean; readonly trigger: RunTrigger["kind"] }>> = {
  user: { head: sourceHead.user, now: true, trigger: "comment" },
  chat: { head: sourceHead.chat, now: false, trigger: "comment" },
  issue: { head: sourceHead.issue, now: false, trigger: "issue" },
  cron: { head: sourceHead.cron, now: false, trigger: "cron" },
  patrol: { head: sourceHead.patrol, now: false, trigger: "runtime" },
};

/** The model id it answers as, on the voice line and on chatCompletionsPath alike. */
export const orchestratorModel = "vibevalley-orchestrator";

export const chatCompletionsPath = "/v1/chat/completions";

/** The orchestrator answers only on DeepSeek: its profile's model as DeepSeek names it. */
export function deepseekModel(configured: string, fallback: string): string {
  if (configured === "") return fallback;
  const slash = configured.indexOf("/");
  if (slash < 0) return configured;
  if (configured.slice(0, slash) === "deepseek") return configured.slice(slash + 1);
  throw new Error(t("server.orchestrator.onlyDeepseek", { configured }));
}

export function quotaText(info: RuntimeInfo | undefined): string {
  const budget = info?.settings.dailyBudget ?? 0;
  const spentToday = info?.spentToday;
  const low = info?.quota?.left !== undefined && info.quota.left < quotaLow ? quotaWords.low : "";
  let today = "";
  if (spentToday !== undefined || budget > 0) {
    today = quotaWords.today(yuan(spentToday ?? 0));
    if (budget > 0) today += quotaWords.budget(yuan(budget));
  }
  return quotaWords.line(info?.quota?.text, low, today);
}

interface SituationLine {
  readonly head: string;
  readonly line: string;
}

/** An item ("- …", or indented) is known by the head above it too: the same the empty-helper line under two channels is two lines. */
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

/** What changed from before to now, line by line: + for a line now has and before had not, − for one gone, each item after the head it is under. */
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
const lineMax = 800;

/** As envelopeLines, but what others said past lineMax is cut, with where to read it whole. The user's words stay whole. */
export const orchestratorEnvelopeLines = (messages: readonly Envelope[]) =>
  messages
    .map((m) => {
      const text = m.text.trim();
      return messageLine(
        m.number !== 0 && m.from !== userId && text.length > lineMax ? { ...m, text: head(text, lineMax) + lineWords.cut(text.length, m.target) } : m,
      );
    })
    .join("\n");
