import { lineWords, quotaWords, situationWords } from "./prompts.ts";
import { ownerId, type RuntimeInfo } from "@vibevalley/protocol";
import { head } from "@/base/clip.ts";
import { type InboxMessage } from "@/channel/wake.ts";
import { messageLine } from "@/channel/prompts.ts";
import { quotaLow, yuan } from "@/runtime/money.ts";

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
