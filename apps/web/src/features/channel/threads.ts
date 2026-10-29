import { t } from "@vibevalley/i18n";

import { type Chat, type Channel, type Issue, type Session } from "@vibevalley/protocol";
const findLast = <T>(xs: readonly T[] | undefined, test: (x: T) => boolean) => {
  if (!xs) return undefined;
  for (let i = xs.length - 1; i >= 0; i--) if (test(xs[i]!)) return xs[i];
  return undefined;
};

/** One thread per issue, kept across the sessions that work it. */
export const issueThreadOf = (chat: Chat | undefined, issue: string) => findLast(chat?.channels, (c) => c.subjectKind === "issue" && c.subjectId === issue);

/** The one way from a session to its thread: through its issue; a session sent for no issue has a talk thread of its own. */
export function jobThreadOf(chat: Chat | undefined, session: Session) {
  if (session.issue) return issueThreadOf(chat, session.issue);
  return findLast(chat?.channels, (c) => c.subjectKind === "talk" && c.subjectId === session.id);
}

export function threadOwnerOf<S extends Session>(thread: Channel, sessions: readonly S[]): S | undefined {
  switch (thread.subjectKind) {
    case "issue":
      return findLast(sessions, (h) => h.issue === thread.subjectId);
    case "talk":
      return sessions.find((h) => h.id === thread.subjectId);
    // Only issues and talks have an owner.
    case "graph":
    default:
      return undefined;
  }
}

const head = (text: string) => {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 24 ? flat.slice(0, 24) : flat;
};

/** Named by the issue, so the name holds after its sessions leave. */
export function threadTitle(thread: Channel, issues: Issue[] = [], sessions: Session[] = []) {
  switch (thread.subjectKind) {
    case "issue": {
      const issue = issues.find((i) => i.id === thread.subjectId);
      return issue ? head(issue.title) : t("web.channel.names.issueThread");
    }
    case "graph":
      return t("web.channel.names.planThread", { id: thread.subjectId ?? "" });
    case "talk":
    default: {
      if (thread.subjectKind === "talk" && thread.subjectId) {
        const session = sessions.find((h) => h.id === thread.subjectId);
        return t("web.channel.names.talkThread", { who: session?.name || thread.title || (thread.subjectId ?? "") });
      }
      return thread.title || t("web.channel.names.thread");
    }
  }
}
