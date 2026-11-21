import { list, t } from "@vibevalley/i18n";
import type { Session } from "@vibevalley/protocol";

export type SubagentSummary = NonNullable<Session["subagents"]>;

export function describeSubagents(summary: SubagentSummary) {
  const names = new Map(summary.threads.map((thread) => [thread.threadId, thread.task || thread.agentName || thread.threadId]));
  const name = (id: string) => (id === summary.rootThreadId ? t("web.session.subagents.root") : (names.get(id) ?? id));
  const disconnected = summary.disconnectedAt !== undefined;
  const waits = summary.waits.map((wait) => {
    const who = name(wait.threadId);
    const targets = list(wait.targets.map(name));
    let text: string;
    if (wait.targets.length === 0) {
      text = disconnected ? t("web.session.subagents.lastMailbox", { who }) : t("web.session.subagents.mailbox", { who });
    } else {
      text = disconnected ? t("web.session.subagents.lastWait", { who, targets }) : t("web.session.subagents.wait", { who, targets });
    }
    return { key: JSON.stringify([wait.threadId, wait.callId]), text };
  });
  return { name, waits };
}
