import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { assignedAgentOf, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { user } from "#/base/actor.ts";
import { messageOf, reasonOf } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { dbQueries, SqlError } from "#/infra/db.ts";
import { gitRuns } from "#/modules/repo/git.ts";
import { HireRefused } from "#/modules/session/session.ts";
import { gitIn } from "#/testing/git.ts";
import { starter, testConfig, until, waitFor } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";
import { testIssues, world } from "#/testing/world.ts";

const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

const busy = scriptedRuntime({ id: "pi", turn: (turn) => new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve())) });

const config = () => {
  const c = testConfig();
  return { ...c, repo: { ...c.repo, maxSessions: 1 } };
};

const farm = async (runtimes = [busy]) => {
  const c = config();
  return { config: c, world: await world({ config: c, runtimes, repos: ["demo"] }) };
};

/** What p was refused with, held to be an `as`. */
const flip = async <E extends Error>(p: Promise<unknown>, as: abstract new (...args: never[]) => E): Promise<E> => {
  const e = await p.then(
    () => expect.unreachable("it was refused"),
    (e: unknown) => e,
  );
  expect(e).toBeInstanceOf(as);
  if (!(e instanceof as)) throw e;
  return e;
};

/** The test's clock: vitest's fake timers move the wall clock the farm reads. */
const fakeClock = () => vi.useFakeTimers({ toFake: ["Date"] });
const adjust = (ms: number) => vi.setSystemTime(Date.now() + ms);
afterEach(() => {
  vi.useRealTimers();
});

const git = gitIn;

const noWorktree = (root: string) => {
  const dir = join(root, "repos", "demo");
  expect(git(dir, "worktree", "list", "--porcelain").split("worktree ").length - 1).toBe(1);
  expect(git(dir, "branch", "--list", "vibevalley/*").trim()).toBe("");
};

const occupied = (core: Core, runtime: string) =>
  core.apply({
    type: "sessionChanged",
    session: {
      id: sessionId("occupied"),
      role: "worker",
      name: "occupied",
      agent: "x",
      runtime,
      brief: "",
      repo: "demo",
      hiredAt: 0,
      runs: 0,
      phase: { _tag: "working", since: 0, doing: { action: "thinking", label: "" } },
      refining: false,
    },
  });

describe("issues", () => {
  it("regression: responsibility starts before execution and changes only when the agent changes", async () => {
    fakeClock();
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const issue = await issues.add({ title: "unstarted responsibility", agent: " lab ", repo: "demo" });
    const original = (await issues.get(issue.id)).assignments;
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({ issue: issue.id, agent: "lab", executions: [] });
    expect(sessionIdsOf(issue)).toEqual([]);
    adjust(100);
    await issues.edit(issue.id, { title: "same responsibility", agent: "lab" }, user);
    expect((await issues.get(issue.id)).assignments).toEqual(original);
    await issues.edit(issue.id, { agent: "lab2" }, user);
    const reassigned = (await issues.get(issue.id)).assignments;
    expect(reassigned.map((a) => [a.agent, a.endedAt !== undefined, a.executions])).toEqual([
      ["lab", true, []],
      ["lab2", false, []],
    ]);
    expect(reassigned[0]?.id).toBe(original[0]?.id);
    expect(reassigned[0]?.endedAt).toBe(reassigned[1]?.assignedAt);
    await issues.edit(issue.id, { agent: "   " }, user);
    expect((await issues.get(issue.id)).assignments.every((a) => a.endedAt !== undefined)).toBe(true);
    const issue3 = await issues.get(issue.id);
    expect(assignedAgentOf(issue3)).toBeUndefined();
  });

  it("regression: an orchestrator owns several issues and repeated delivery keeps each responsibility", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const chat = w.channel;
    const first = await issues.add({ title: "first responsibility", agent: defaultOrchestrator });
    const second = await issues.add({ title: "second responsibility", agent: defaultOrchestrator });
    const before = (await issues.get(first.id)).assignments;
    await issues.start(first.id, chat.defaultChannel());
    await issues.start(second.id, chat.defaultChannel());
    const once = (await issues.get(first.id)).assignments;
    await issues.start(first.id, chat.defaultChannel());
    expect((await issues.get(first.id)).assignments).toEqual(once);
    expect(once[0]?.id).toBe(before[0]?.id);
    for (const issue of [first, second]) {
      const assignments = (await issues.get(issue.id)).assignments;
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.executions).toEqual([{ kind: "orchestrator", session: defaultOrchestrator, startedAt: expect.any(Number) }]);
      const issue3 = await issues.get(issue.id);
      expect(sessionIdsOf(issue3)).toEqual([]);
    }
  });

  it("regression: a rejected responsibility change keeps both the agent and assignment history", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const issue = await issues.add({ title: "atomic responsibility", agent: "lab" });
    const before = (await issues.get(issue.id)).assignments;
    const db = w.db;
    await refuse(db, "reject_assignment", "before insert on issue_assignment", "", "assignment refused");
    await expect(issues.edit(issue.id, { agent: "lab2" }, user)).rejects.toBeDefined();
    const issue3 = await issues.get(issue.id);
    expect(assignedAgentOf(issue3)).toBe("lab");
    expect((await issues.get(issue.id)).assignments).toEqual(before);
  });

  it("regression: completion and cancellation keep responsibility across new execution contexts", async () => {
    const f = await farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("结论：做完了") })]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    const chat = w.channel;
    await w.agent.save(lab());
    const issue = await issues.add({ title: "continued responsibility", agent: "lab", repo: "demo" });
    const [original] = (await issues.get(issue.id)).assignments;
    const ready = (count: number) =>
      waitFor(
        () => issues.get(issue.id),
        (i) => i.status === "in_review" && sessionIdsOf(i).length === count,
        "the next execution",
      );
    await issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), user);
    await ready(1);
    await issues.setStatus(issue.id, "done", "", chat.defaultChannel(), user);
    await issues.setStatus(issue.id, "todo", "continue", chat.defaultChannel(), user);
    await ready(2);
    await issues.setStatus(issue.id, "canceled", "", chat.defaultChannel(), user);
    await issues.setStatus(issue.id, "todo", "continue again", chat.defaultChannel(), user);
    await ready(3);
    const assignments = (await issues.get(issue.id)).assignments;
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.id).toBe(original?.id);
    expect(assignments[0]?.endedAt).toBeUndefined();
    expect(assignments[0]?.executions).toHaveLength(3);
  });

  it("regression: deleting another issue while reassigning cannot restore a stale responsibility snapshot", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const issue = await issues.add({ title: "concurrent responsibility", agent: "lab" });
    for (let n = 0; n < 10; n++) {
      const disposable = await issues.add({ title: "discarded" });
      const agent = n % 2 === 0 ? "lab2" : "lab";
      await Promise.all([issues.remove(disposable.id), issues.edit(issue.id, { agent: agent }, user)]);
      const history = (await issues.get(issue.id)).assignments;
      expect(history).toHaveLength(n + 2);
      expect(history.filter((a) => a.endedAt === undefined).map((a) => a.agent)).toEqual([agent]);
      const issue3 = await issues.get(issue.id);
      expect(assignedAgentOf(issue3)).toBe(agent);
    }
  });

  // A budget: a board of twenty issues is one read of the table, and asks git nothing.
  it("listing twenty issues reads the database at most twice and runs no git", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const before = dbQueries.count();
    for (let n = 1; n <= 20; n++) await issues.add({ title: `第 ${n} 件`, repo: "demo" });
    // The counter counts: adding them asked the database.
    expect(dbQueries.count()).toBeGreaterThan(before);
    const [queries, gits] = [dbQueries.count(), gitRuns.count()];
    expect((await issues.list()).length).toBe(20);
    const used = { queries: dbQueries.count() - queries, gits: gitRuns.count() - gits };
    expect(used.queries, JSON.stringify(used)).toBeLessThanOrEqual(2);
    expect(used.gits).toBe(0);
  });

  it("a prompt that starts then fails keeps the unclosed startup reserved", async () => {
    let turns = 0;
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    const cleanups: (() => Promise<void>)[] = [];
    const base = scriptedRuntime({
      id: "pi",
      turn: (turn) =>
        new Promise<void>((resolve) => {
          turns++;
          writeFileSync(join(turn.options.cwd, `owned-${turns}.txt`), "the failed prompt still owns this worktree\n");
          wrote();
          turn.signal.addEventListener("abort", () => resolve());
        }),
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        cleanups.push(async () => {
          await session.dispose();
        });
        return {
          ...session,
          prompt: async (...input: Parameters<typeof session.prompt>) => {
            await session.prompt(...input);
            await written;
            throw new Error("prompt transport dropped");
          },
          dispose: async () => {
            throw new Error("did not stop");
          },
        };
      },
    };
    const f = await farm([runtime]);
    await using w = f.world;
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup()));
      },
    };
    const issues = testIssues(w.issue);
    const sessions = w.session;
    const agent = { ...lab(), worktree: true };
    const first = await flip(issues.hire(agent, "first work", "demo"), HireRefused);
    expect(first.reason).toContain("prompt transport dropped");
    expect(first.reason).toContain("did not stop");
    expect(sessions.noRoom("pi", "demo")).not.toBe("");
    const issue = (await issues.list())[0]!;
    const second = await flip(issues.hire(agent, "do not overlap", "demo", { issue: issue.id }), HireRefused);
    expect(second).toBeInstanceOf(HireRefused);
    expect(turns).toBe(1);
  });

  it("a refused dispatch whose runtime cannot close keeps its workplace reserved", async () => {
    let turns = 0;
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    const cleanups: (() => Promise<void>)[] = [];
    const base = scriptedRuntime({
      id: "pi",
      turn: (turn) =>
        new Promise<void>((resolve) => {
          turns++;
          writeFileSync(join(turn.options.cwd, "still-owned.txt"), "the failed start is still writing\n");
          wrote();
          turn.signal.addEventListener("abort", () => resolve());
        }),
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        cleanups.push(async () => {
          await session.dispose();
        });
        return {
          ...session,
          prompt: async (...input: Parameters<typeof session.prompt>) => {
            const outcome = await session.prompt(...input);
            await written;
            return outcome;
          },
          dispose: async () => {
            throw new Error("did not stop");
          },
        };
      },
    };
    const f = await farm([runtime]);
    await using w = f.world;
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup()));
      },
    };
    const issues = testIssues(w.issue);
    const sessions = w.session;
    await refuse(w.db, "reject_link", "before insert on issue_assignment_execution", "", "link refused");
    const agent = { ...lab(), worktree: true };
    expect((await flip(issues.hire(agent, "first work", "demo"), HireRefused)).reason).toContain("did not stop");
    const issue = (await issues.list())[0]!;
    expect(issue).toBeDefined();
    await expect(issues.remove(issue.id)).rejects.toBeDefined();
    expect(existsSync(join(f.config.workRoot, "worktrees", "demo.1", "still-owned.txt"))).toBe(true);
    await allow(w.db, "reject_link");
    const again = await flip(issues.hire(agent, "do not overlap", "demo", { issue: issue.id }), HireRefused);
    expect(again.reason).toBeTruthy();
    expect(sessions.noRoom("pi", "demo")).not.toBe("");
    expect(turns).toBe(1);
  });

  it("a refused dispatch keeps the identity of any work it already wrote", async () => {
    let turns = 0;
    let inherited = false;
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turns++;
        const cwd = turn.options.cwd;
        if (turns === 1) {
          writeFileSync(join(cwd, "failed-dispatch.txt"), "belongs to the failed dispatch\n");
          git(cwd, "add", "failed-dispatch.txt");
          git(cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "failed dispatch work");
          wrote();
        } else inherited = existsSync(join(cwd, "failed-dispatch.txt"));
        turn.say("结论：做完了");
      },
    });
    const worker = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        return {
          ...session,
          prompt: async (...input: Parameters<typeof session.prompt>) => {
            const outcome = await session.prompt(...input);
            await written;
            return outcome;
          },
        };
      },
    };
    const f = await farm([worker]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    await refuse(w.db, "reject_link", "before insert on issue_assignment_execution", "", "link refused");
    const agent = { ...lab(), worktree: true };
    expect((await flip(issues.hire(agent, "first work", "demo"), HireRefused)).reason).toContain("link refused");
    const kept = await issues.list();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ number: 1, title: "first work", assignments: [{ agent: "lab", executions: [] }] });
    await expect(issues.edit(kept[0]!.id, { repo: "elsewhere" }, user)).rejects.toBeDefined();
    expect((await issues.get(kept[0]!.id)).repo).toBe("demo");
    await expect(issues.remove(kept[0]!.id)).rejects.toBeDefined();
    expect((await issues.list()).map((i) => i.id)).toEqual([kept[0]!.id]);
    await allow(w.db, "reject_link");
    const next = await issues.hire(agent, "unrelated work", "demo");
    expect(next.session.branch).toBe("vibevalley/issue-2");
    await until(() => turns === 2, "the unrelated dispatch");
    expect(inherited).toBe(false);
  });

  it("a draft whose runtime refuses to stop keeps its session and workplace", async () => {
    let stopped = false;
    let started = false;
    let disposeCalls = 0;
    let cleanup = async () => {};
    const base = scriptedRuntime({
      id: "pi",
      turn: (turn) =>
        new Promise<void>((resolve) => {
          writeFileSync(join(turn.options.cwd, "still-owned.txt"), "the writer is still alive\n");
          started = true;
          turn.signal.addEventListener("abort", () => {
            stopped = true;
            resolve();
          });
        }),
    });
    const worker = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        cleanup = async () => {
          await session.dispose();
        };
        return {
          ...session,
          dispose: async () => {
            disposeCalls++;
            throw new Error("did not stop");
          },
        };
      },
    };
    const f = await farm([worker]);
    await using w = f.world;
    await using _cleanup = { [Symbol.asyncDispose]: () => cleanup() };
    const issues = testIssues(w.issue);
    const sessions = w.session;
    await w.agent.save(lab());
    const issue = await issues.add({ title: "draft", repo: "demo", agent: "lab" });
    await issues.refine(issue.id, "keep reading", "");
    await until(() => started, "the writer");
    expect((await issues.get(issue.id)).assignments.map((a) => [a.agent, a.executions])).toEqual([["lab", []]]);
    const id = (await issues.get(issue.id)).refining!.session;
    const cwd = sessions.cwdOf(id)!;
    for (let n = 0; n < 2; n++) {
      const result = await issues.setStatus(issue.id, "canceled", "", "", user).then(
        () => expect.unreachable("the cancel went through"),
        (e: unknown) => e,
      );
      expect(messageOf(result)).toContain("did not stop");
      expect(sessions.sessionOf(id)).toBeDefined();
      expect(existsSync(join(cwd, "still-owned.txt"))).toBe(true);
      expect(stopped).toBe(false);
    }
    expect(disposeCalls).toBe(1);
  });

  it("canceling a draft stops its writer before discarding the work", async () => {
    let started = false;
    const worker = scriptedRuntime({
      id: "pi",
      turn: (turn) =>
        new Promise<void>((resolve) => {
          started = true;
          turn.signal.addEventListener("abort", () => {
            const cwd = turn.options.cwd;
            writeFileSync(join(cwd, "last-write.txt"), "written while stopping\n");
            git(cwd, "add", "last-write.txt");
            git(cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "last draft write");
            resolve();
          });
        }),
    });
    const f = await farm([worker]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    await w.agent.save(lab());
    const issue = await issues.add({ title: "draft", repo: "demo", agent: "lab" });
    await issues.refine(issue.id, "read the repo", "");
    await until(() => started, "the drafting writer");
    await issues.setStatus(issue.id, "canceled", "", "", user);
    noWorktree(f.config.workRoot);
  });

  it("an immediate dispatch owns its issue's branch before the helper starts, and reopens it", async () => {
    let firstBranch = "";
    const worker = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const cwd = turn.options.cwd;
        if (!firstBranch) {
          firstBranch = git(cwd, "branch", "--show-current").trim();
          writeFileSync(join(cwd, "kept.txt"), "keep this work\n");
          git(cwd, "add", "kept.txt");
          git(cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "first dispatch");
        }
        turn.say("结论：做完了");
      },
    });
    const f = await farm([worker]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    const sessions = w.session;
    await w.agent.save(lab());
    const hired = await issues.hire({ ...lab(), worktree: true }, "keep my work", "demo");
    const first = hired.session;
    await until(() => sessions.sessionOf(first.id)?.phase._tag === "done", "the dispatch's report");
    const issue = await issues.get(first.issue!);
    expect([first.branch, firstBranch]).toEqual([`vibevalley/issue-${issue.number}`, `vibevalley/issue-${issue.number}`]);
    const commit = git(first.worktree!, "rev-parse", "HEAD").trim();
    await issues.setStatus(issue.id, "canceled", "", "", user);
    await waitFor(
      () => issues.get(issue.id),
      (i) => i.status === "canceled",
      "the canceled issue",
    );
    const setStatus2 = await issues.setStatus(issue.id, "todo", "keep going", "", user);
    const again = latestSessionIdOf(setStatus2);
    if (again === undefined) throw new Error("the issue has no reopened session");
    const reopened = sessions.sessionOf(again)!;
    expect([reopened.branch, reopened.worktree]).toEqual([first.branch, first.worktree]);
    expect(git(reopened.worktree!, "rev-parse", "HEAD").trim()).toBe(commit);
    expect(reopened.brief).toContain("这条分支上已经有上次的提交");
  });

  it("a session that cannot be opened gives its worktree back", async () => {
    const f = await farm();
    await using w = f.world;
    const sessions = w.session;
    const got = await flip(
      sessions.hire({ ...lab(), runtime: "missing-runtime", worktree: true }, "test", "demo", {
        context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
      }),
      HireRefused,
    );
    expect([got.name, got.reason !== ""]).toEqual(["HireRefused", true]);
    noWorktree(f.config.workRoot);
  });

  it("regression: refused startup removes only the issue made for that dispatch and keeps an existing queue", async () => {
    const f = await farm([
      {
        ...busy,
        session: async () => {
          throw new Error("startup refused");
        },
      },
    ]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    const sessions = w.session;
    const core = w.core;
    const agent = { ...lab(), worktree: true };
    const refused = await flip(issues.hire(agent, "new work", "demo"), HireRefused);
    expect(refused.reason).toContain("startup refused");
    const issues2 = await issues.list();
    expect(issues2).toEqual([]);
    expect(core.state().issues).toEqual([]);
    expect(sessions.hired()).toEqual([]);
    noWorktree(f.config.workRoot);

    const existing = await issues.add({ title: "already queued", repo: "demo", agent: agent.id });
    occupied(core, "pi");
    await w.agent.save(agent);
    const queued = await issues.setStatus(existing.id, "todo", "", "", user);
    core.apply({ type: "sessionLeft", id: sessionId("occupied") });
    expect((await flip(issues.hire(agent, "new attempt", "demo", { issue: existing.id }), HireRefused)).reason).toContain("startup refused");
    const kept = await issues.get(existing.id);
    expect([kept.number, kept.queuedAt, sessionIdsOf(kept)]).toEqual([existing.number, queued.queuedAt, []]);
    noWorktree(f.config.workRoot);
  });

  it("an issue that cannot be written publishes no session and keeps none", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const core = w.core;
    const sessions = w.session;
    await w.db.sql.query(`select 1`);
    await refuse(w.db, "reject_issue", "before insert on issue", "", "test write failure");
    const got = await flip(issues.hire({ ...lab(), worktree: true }, "test", "demo"), HireRefused);
    expect(got.reason).toContain("test write failure");
    expect([core.state().sessions.filter((s) => s.role === "worker").length, sessions.hired().length]).toEqual([0, 0]);
    noWorktree(f.config.workRoot);
  });

  it("two sends at once honour the repo's room", async () => {
    const f = await farm();
    await using w = f.world;
    const sessions = w.session;
    const core = w.core;
    const got = await Promise.allSettled([
      sessions.hire(lab(), "test", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } }),
      sessions.hire(lab(), "test", "demo", { context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } } }),
    ]);
    expect(got.filter((h) => h.status === "fulfilled").length).toBe(1);
    expect(got.filter((h) => h.status === "rejected").length).toBe(1);
    expect(core.state().sessions.filter((s) => s.role === "worker")).toHaveLength(1);
  });

  it("an optional SQL row hides only absence, never a database failure", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const issue = await issues.add({ title: "read errors" });
    expect((await flip(issues.get("not-there"), ApiError)).bizCode).toBe(BizCode.IssueNotFound);
    await w.db.sql.exec("alter table issue rename to issue_broken");
    const out = await issues.get(issue.id).then(
      () => expect.unreachable("the issue was read"),
      (e: unknown) => e,
    );
    // A database failure, not a refusal: it is not told as "not found".
    expect(out).toBeInstanceOf(SqlError);
    expect(out).not.toBeInstanceOf(ApiError);
  });

  it("a git failure cannot complete an issue as if it had no changes", async () => {
    const worker = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        writeFileSync(join(turn.options.cwd, "committed.txt"), "work\n");
        git(turn.options.cwd, "add", "committed.txt");
        git(turn.options.cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "work");
        turn.say("结论：做完了");
      },
    });
    const f = await farm([worker]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    const sessions = w.session;
    const chat = w.channel;
    await w.agent.save(lab());
    const hired = await issues.hire({ ...lab(), worktree: true }, "keep my work", "demo");
    await until(() => sessions.sessionOf(hired.session.id)?.phase._tag === "done", "the report");
    const repo = join(f.config.workRoot, "repos", "demo");
    renameSync(join(repo, ".git"), join(repo, ".git-hidden"));
    expect((await flip(issues.previewStatus(hired.session.issue!, "done", ""), ApiError)).bizCode).toBe(BizCode.IssueRefused);
    expect((await flip(issues.setStatus(hired.session.issue!, "done", "", chat.defaultChannel(), user), ApiError)).bizCode).toBe(BizCode.IssueRefused);
    const after = await issues.get(hired.session.issue!);
    expect([after.status, after.delivered]).toEqual(["in_review", undefined]);
  });

  it("an issue's actions act on its latest session", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const sessions = w.session;
    const first = await issues.hire(lab(), "first", "demo");
    const id = first.session.issue!;
    await sessions.dismiss(first.session.id);
    const second = await issues.hire(lab(), "second", "demo", { issue: id });
    expect(second.session).toBeDefined();
    await issues.changes(id, user);
    await expect(issues.setStatus(id, "done", "", "", user)).rejects.toBeDefined();
    expect(sessions.sessionOf(second.session.id)).toBeDefined();
    await issues.setStatus(id, "canceled", "", "", user);
    expect(sessions.sessionOf(second.session.id)).toBeUndefined();
    await expect(issues.changes(id, user)).rejects.toBeDefined();
  });

  it("a queued issue keeps the channel it was first sent from", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const core = w.core;
    const chat = w.channel;
    const sessions = w.session;
    await w.agent.save(lab());
    const first = await chat.openChannel("first", "", "demo");
    const second = await chat.openChannel("second", "", "demo");
    occupied(core, "pi");
    const issue = await issues.add({ title: "queued", agent: "lab", repo: "demo" });
    for (const channel of [first.id, second.id]) expect((await issues.start(issue.id, channel)).queued).toBeDefined();
    await w.issue.refreshQueue();
    expect(
      (
        await w.db.sql.query(
          `select t.trigger_json::jsonb->>'replyChannel' as channel
        from session_issue_input m join session_trigger t on t.id = m.trigger_id where m.issue_id = $1 and m.state = 'held'`,
          [issue.id],
        )
      ).map((r) => r["channel"]),
    ).toEqual([first.id]);
    core.apply({ type: "sessionLeft", id: sessionId("occupied") });
    const started = await issues.start(issue.id, second.id);
    expect(started.queued).toBeDefined();
    await w.issue.refreshQueue();
    const got = await issues.get(issue.id);
    expect(sessionIdsOf(got)).toHaveLength(1);
    const queuedSession = sessionIdsOf(got)[0];
    if (queuedSession === undefined) throw new Error("the issue has no execution session");
    expect((await sessions.get(queuedSession))?.channel).toBe(first.id);
    await waitFor(
      () => sessions.issueRuns(issue.id),
      (r) => r.length > 0,
      "the queued run",
    );
    expect((await sessions.issueRuns(issue.id))[0]!.triggeredBy.kind).toBe("issue");
    const rows = await w.db.sql.query(`select 1 from session_issue_input where issue_id = $1 and state = 'held'`, [issue.id]);
    expect(rows).toEqual([]);
  });

  it("regression: requeueing uses the new source and retires the previous dispatch", async () => {
    const inputs: string[] = [];
    const f = await farm([
      scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          inputs.push(turn.input);
          turn.say("done");
        },
      }),
    ]);
    await using w = f.world;
    const issues = testIssues(w.issue);

    const core = w.core;
    const chat = w.channel;
    const sessions = w.session;
    await w.agent.save(lab());
    const first = await chat.openChannel("queue-old", "", "demo");
    const second = await chat.openChannel("queue-new", "", "demo");
    occupied(core, "pi");
    const item = await issues.add({ title: "queued", description: "old-dispatch-context", agent: "lab", repo: "demo" });
    await issues.start(item.id, first.id);
    await w.issue.refreshQueue();
    await issues.setStatus(item.id, "backlog", "", "", user);
    await issues.edit(item.id, { description: "new-dispatch-context" }, user);
    await issues.start(item.id, second.id);
    await w.issue.refreshQueue();
    core.apply({ type: "sessionLeft", id: sessionId("occupied") });
    await w.issue.refreshQueue();
    await until(() => inputs.length > 0, "the requeued input");
    expect(inputs[0]).toContain("new-dispatch-context");
    expect(inputs[0]).not.toContain("old-dispatch-context");
    const issue2 = await issues.get(item.id);
    const session = sessionIdsOf(issue2)[0]!;
    expect((await sessions.get(session))?.channel).toBe(second.id);
  });

  it("a queued cron keeps its trigger and that it was missed", async () => {
    fakeClock();
    const c = config();
    await using w = await world({ config: c, runtimes: [busy], repos: ["demo"] });
    const issues = testIssues(w.issue);
    const core = w.core;
    const chat = w.channel;
    const sessions = w.session;
    const crons = w.cron;
    await w.agent.save(lab());
    const channel = await chat.openChannel("scheduled", "", "demo");
    occupied(core, "pi");
    const sc = await crons.add({ name: "scheduled", text: "work", channel: channel.id, agent: "lab", when: { kind: "every", minutes: 1 } }, user);
    adjust(10 * 60_000);
    await crons.tick();
    const issue = await waitFor(
      async () => (await issues.list()).find((item) => item.cron === sc.id),
      (item) => item?.queuedAt !== undefined,
      "the cron queued",
    );
    core.apply({ type: "sessionLeft", id: sessionId("occupied") });
    await w.issue.refreshQueue();
    await waitFor(
      () => sessions.issueRuns(issue!.id),
      (r) => r.length > 0,
      "the scheduled run",
    );
    const [run] = await sessions.issueRuns(issue!.id);
    expect(run!.triggeredBy).toEqual({ kind: "cron", cron: sc.id, missed: true, message: issue!.mandate.originTriggerId });
    expect((await sessions.get(run!.session))?.channel).toBe(channel.id);
  });

  it("a queued todo starts once there is room, and keeps its place until then", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const core = w.core;
    const chat = w.channel;
    await w.agent.save(lab());
    occupied(core, "pi");
    const issue = await issues.add({ title: "queued", agent: "lab", repo: "demo" });
    expect((await issues.start(issue.id, chat.defaultChannel())).queued).toBeDefined();
    const queued = await issues.get(issue.id);
    await w.issue.refreshQueue();
    const stillQueued = await issues.get(issue.id);
    expect([stillQueued.queuedAt, sessionIdsOf(stillQueued)]).toEqual([queued.queuedAt, []]);
    core.apply({ type: "sessionLeft", id: sessionId("occupied") });
    await w.issue.refreshQueue();
    const issue3 = await issues.get(issue.id);
    expect(sessionIdsOf(issue3)).toHaveLength(1);
  });

  it("an issue handed over goes on in the same issue with another profile", async () => {
    const f = await farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") })]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    const sessions = w.session;
    const chat = w.channel;
    const agents = w.agent;
    await agents.save(lab());
    await agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
    const issue = await issues.add({ title: "write hello", agent: "lab", repo: "demo" });
    const original = (await issues.get(issue.id)).assignments;
    const inReview = (n: number) =>
      waitFor(
        () => issues.get(issue.id),
        (t) => t.status === "in_review" && sessionIdsOf(t).length === n,
        "round " + n,
      );
    await issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), user);
    await inReview(1);
    const issue3 = await issues.get(issue.id);
    const [first] = sessionIdsOf(issue3);
    const refused = (to: "done" | "todo", agent: string) =>
      flip(issues.setStatus(issue.id, to, "", chat.defaultChannel(), user, { agent: agent }), ApiError).then(reasonOf);
    const refused2 = await refused("done", "lab2");
    expect(refused2).toContain("换人是挪到待办时的事");
    const refused3 = await refused("todo", "nobody");
    expect(refused3).toContain("没有叫 nobody 的档案");

    const handed = await issues.setStatus(issue.id, "todo", "接着写", chat.defaultChannel(), user, { agent: "Lab Two" });
    expect([assignedAgentOf(handed), sessionIdsOf(handed).length, handed.closedAt]).toEqual(["lab2", 2, undefined]);
    if (first === undefined) throw new Error("the issue has no first execution session");
    expect(sessions.sessionOf(first)).toBeUndefined();
    const next = sessionIdsOf(handed)[1];
    if (next === undefined) throw new Error("the issue has no second execution session");
    const second = (await sessions.get(next))!;
    expect(second.agent).toBe("lab2");
    expect(second.brief).toMatch(/^接着写\n\n（这张工单换你接手了，之前是 /u);
    await inReview(2);
    const assignments = (await issues.get(issue.id)).assignments;
    expect(assignments.map((a) => [a.agent, a.endedAt !== undefined, a.executions.map((e) => e.session)])).toEqual([
      ["lab", true, [first]],
      ["lab2", false, [second.id]],
    ]);
    expect(assignments[0]?.id).toBe(original[0]?.id);
  });

  it("an issue still being worked is not handed over", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const chat = w.channel;
    const agents = w.agent;
    await agents.save(lab());
    await agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
    const issue = await issues.add({ title: "work on", agent: "lab", repo: "demo" });
    await issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), user);
    await waitFor(
      () => issues.get(issue.id),
      (t) => t.status === "in_progress",
      "working",
    );
    const setStatusFailure = await flip(issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), user, { agent: "lab2" }), ApiError);
    expect(reasonOf(setStatusFailure)).toContain("先叫停，等它停下再换人");
    const issue3 = await issues.get(issue.id);
    expect(sessionIdsOf(issue3)).toHaveLength(1);
  });

  it("history joins live and ended sessions", async () => {
    const f = await farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") })]);
    await using w = f.world;
    const issues = testIssues(w.issue);
    const sessions = w.session;
    const issue = await issues.add({ title: "history", repo: "demo", agent: "lab" });
    const first = (await issues.hire(lab(), "first", "demo", { issue: issue.id })).session;
    await until(() => sessions.sessionOf(first.id)?.phase._tag === "done", "the first report");
    await sessions.dismiss(first.id);
    const live = (await issues.hire(lab(), "second", "demo", { issue: issue.id })).session;
    await until(() => sessions.sessionOf(live.id)?.phase._tag === "done", "the live report");
    await sessions.suspend(live.id);
    const missing = (await issues.hire(lab(), "third", "demo", { issue: issue.id })).session;
    await until(() => sessions.sessionOf(missing.id)?.phase._tag === "done", "the third report");
    await sessions.dismiss(missing.id);
    const [got] = await issues.history();
    expect(got!.sessions.map((s) => [s.id, s.phase._tag])).toEqual([
      [first.id, "closed"],
      [live.id, "done"],
      [missing.id, "closed"],
    ]);
    expect(got!.missingSessions).toEqual([]);
  });

  it("reordering one unsent issue updates only that row in constant queries, and resolves issues by active helper name", async () => {
    const f = await farm();
    await using w = f.world;
    const issues = testIssues(w.issue);
    const core = w.core;
    const created: T.Issue[] = [];
    for (let n = 1; n <= 20; n++) {
      const added = await issues.add({ title: `card-${n}`, repo: "demo" });
      created.push(added);
    }
    const first = created[0]!;
    const fifth = created[4]!;
    const last = created[19]!;

    const beforeMove = dbQueries.count();
    await issues.edit(last.id, { before: first.id }, user);
    const moveQueries = dbQueries.count() - beforeMove;
    expect(moveQueries).toBeLessThanOrEqual(8);
    expect((await issues.list()).slice(0, 2).map((i) => i.id)).toEqual([last.id, first.id]);

    await issues.edit(first.id, { before: fifth.id }, user);
    const orderAfterMiddle = (await issues.list()).map((i) => i.id);
    expect(orderAfterMiddle.indexOf(first.id)).toBe(orderAfterMiddle.indexOf(fifth.id) - 1);

    await issues.edit(last.id, { before: "" }, user);
    expect((await issues.list()).at(-1)?.id).toBe(last.id);

    core.apply({
      type: "sessionChanged",
      session: {
        id: sessionId("helper-1"),
        role: "worker",
        name: "阿麦",
        agent: "lab",
        runtime: "pi",
        brief: "work",
        repo: "demo",
        issue: fifth.id,
        hiredAt: 1,
        runs: 1,
        phase: { _tag: "working", since: 1, doing: { action: "thinking", label: "" } },
        refining: false,
      },
    });
    expect((await issues.get("阿麦")).id).toBe(fifth.id);
  });
});
