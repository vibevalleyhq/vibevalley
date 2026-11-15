import type * as T from "@vibevalley/protocol";

import { Inconsistent } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { compare, compareText, or } from "#/base/order.ts";
import type { Db } from "#/infra/db.ts";
import type { PullRequest, PullRequestState } from "#/modules/repo/workplace.ts";
import * as q from "#db/pull.sql.ts";

export interface PullRecord {
  readonly id: string;
  readonly platform: T.BranchPublication["platform"];
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
  readonly state: PullRequestState;
  readonly issueId?: T.IssueId;
  readonly checkFingerprint: string;
  readonly checkRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const recordOf = (row: q.ListPullsResult): PullRecord => ({
  id: row.id,
  platform: row.platform,
  repo: row.repo,
  number: row.number,
  url: row.url,
  branch: row.branch,
  base: row.base,
  state: row.state,
  ...(row.issue_id === null ? {} : { issueId: row.issue_id }),
  checkFingerprint: row.check_fingerprint,
  checkRevision: row.check_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const pullOrder = (a: PullRecord, b: PullRecord) => or(compare(a.createdAt, b.createdAt), compareText(a.id, b.id));

const prefersForIssue = (candidate: PullRecord, current: PullRecord): boolean => {
  if ((candidate.state === "open") !== (current.state === "open")) return candidate.state === "open";
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  return candidate.number >= current.number;
};

class PullIndex {
  private readonly byId = new Map<string, PullRecord>();
  private readonly byRepoNumber = new Map<string, PullRecord>();
  private readonly byIssue = new Map<T.IssueId, PullRecord>();

  load(rows: readonly q.ListPullsResult[]): void {
    this.byId.clear();
    this.byRepoNumber.clear();
    this.byIssue.clear();
    for (const row of rows) this.put(row);
  }

  put(row: q.ListPullsResult): PullRecord {
    const next = recordOf(row);
    const previous = this.byId.get(next.id);
    if (previous) this.byRepoNumber.delete(`${previous.repo}#${previous.number}`);
    this.byId.set(next.id, next);
    this.byRepoNumber.set(`${next.repo}#${next.number}`, next);
    if (previous?.issueId && previous.issueId !== next.issueId) this.recomputeIssue(previous.issueId);
    if (next.issueId) this.recomputeIssue(next.issueId);
    return next;
  }

  private recomputeIssue(issueId: T.IssueId): void {
    let best: PullRecord | undefined;
    for (const item of this.byId.values()) {
      if (item.issueId !== issueId) continue;
      if (!best || prefersForIssue(item, best)) best = item;
    }
    if (best) this.byIssue.set(issueId, best);
    else this.byIssue.delete(issueId);
  }

  ofIssue(issueId: T.IssueId): PullRequest | undefined {
    const found = this.byIssue.get(issueId);
    return found ? { url: found.url, number: found.number, state: found.state } : undefined;
  }

  find(repo: string, number: number): PullRecord | undefined {
    return this.byRepoNumber.get(`${repo}#${number}`);
  }

  all(): PullRecord[] {
    return [...this.byId.values()].toSorted(pullOrder);
  }

  open(): PullRecord[] {
    return [...this.byId.values()].filter((item) => item.state === "open").toSorted(pullOrder);
  }
}

export interface UpsertPullInput {
  readonly platform: T.BranchPublication["platform"];
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
  readonly state: PullRequestState;
  readonly issueId?: T.IssueId;
  readonly at: number;
}

/** Owns the in-memory pull index alongside database writes so `ofIssue` and `find` stay synchronous and committed. */
export async function makePullStore(db: Db) {
  const index = new PullIndex();
  await db.tx(async () => {
    index.load(await q.listPulls(db.sql));
  });

  return {
    ofIssue: (issueId: T.IssueId) => index.ofIssue(issueId),
    find: (repo: string, number: number) => index.find(repo, number),
    all: () => index.all(),
    open: () => index.open(),
    upsertInTx: async (input: UpsertPullInput): Promise<PullRecord> => {
      const saved = await q.upsertPull(db.sql, {
        id: newId(input.at),
        platform: input.platform,
        repo: input.repo,
        number: input.number,
        url: input.url,
        branch: input.branch,
        base: input.base,
        state: input.state,
        issue_id: input.issueId ?? null,
        created_at: input.at,
        updated_at: input.at,
      });
      if (saved === undefined) throw new Inconsistent(`pull ${input.repo}#${input.number}: upsert returned no row`);
      await db.afterCommit(() => {
        index.put(saved);
      });
      return recordOf(saved);
    },
    setStateInTx: async (id: string, state: PullRequestState, at: number): Promise<PullRecord> => {
      const saved = await q.setPullState(db.sql, { id, state, updated_at: at });
      if (saved === undefined) throw new Inconsistent(`pull ${id}: state update returned no row`);
      await db.afterCommit(() => {
        index.put(saved);
      });
      return recordOf(saved);
    },
    observeChecksInTx: async (id: string, checkFingerprint: string, checkRevision: number, at: number): Promise<PullRecord> => {
      const saved = await q.observePullChecks(db.sql, {
        id,
        check_fingerprint: checkFingerprint,
        check_revision: checkRevision,
        updated_at: at,
      });
      if (saved === undefined) throw new Inconsistent(`pull ${id}: check update returned no row`);
      await db.afterCommit(() => {
        index.put(saved);
      });
      return recordOf(saved);
    },
  };
}
