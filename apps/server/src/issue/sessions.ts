// Which sessions worked each issue, oldest first, as the issues keep it in memory: read from issue_session when they
// start, told each session added once its transaction commits, and read again after an issue is removed (the rows go
// with it and with its children's, by cascade). Only the issues write issue_session.

export class IssueSessions {
  private issueOfSession = new Map<string, string>();
  private sessionsOfIssue = new Map<string, string[]>();

  /** Rows as AllSessions gives them: by when they started. */
  load(rows: readonly { issue: string; session: string }[]) {
    this.issueOfSession.clear();
    this.sessionsOfIssue.clear();
    for (const r of rows) this.added(r.session, r.issue);
  }

  /** AddSession: a session already there stays where it was. */
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
