// Oldest first, kept in memory: read from issue_session at start and again after an issue is removed (its rows and its
// children's go by cascade), and told each session added once its transaction commits. Only the issues write issue_session.

export class IssueSessions {
  private issueOfSession = new Map<string, string>();
  private sessionsOfIssue = new Map<string, string[]>();

  /** Rows as AllSessions gives them: by when they started. */
  load(rows: readonly { issue: string; session: string }[]) {
    this.issueOfSession.clear();
    this.sessionsOfIssue.clear();
    for (const r of rows) this.added(r.session, r.issue);
  }

  /** As AddSession: a session already there stays where it was. */
  added(session: string, issue: string) {
    if (this.issueOfSession.has(session)) return;
    this.issueOfSession.set(session, issue);
    this.sessionsOfIssue.set(issue, [...(this.sessionsOfIssue.get(issue) ?? []), session]);
  }

  issueOf(session: string): string | undefined {
    return this.issueOfSession.get(session);
  }

  of(issue: string): string[] {
    return this.sessionsOfIssue.get(issue) ?? [];
  }

  all(): ReadonlyMap<string, string[]> {
    return this.sessionsOfIssue;
  }
}
