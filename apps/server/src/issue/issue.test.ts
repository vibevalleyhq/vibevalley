import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Metric } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Channel } from "@/channel/channel.ts";
import { Core } from "@/core/core.ts";
import { Cron } from "@/cron/cron.ts";
import { reasonOf } from "@/errors.ts";
import { Db, dbQueries } from "@/infra/db.ts";
import { gitRuns } from "@/project/git.ts";
import { Session } from "@/session/session.ts";
import { gitIn } from "@/testing/git.ts";
import { starter, testConfig } from "@/testing/layers.ts";
import { until, waitFor } from "@/testing/until.ts";
import { testIssues, world } from "@/testing/world.ts";

import { Issue } from "./issue.ts";
const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

const busy = scriptedRuntime({ id: "pi", turn: (turn) => new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve())) });

const config = () => {
  const c = testConfig();
  return { ...c, project: { ...c.project, maxSessions: 1 } };
};

const farm = (runtimes = [busy]) => {
  const c = config();
  return { config: c, layer: world({ config: c, runtimes, repos: ["demo"] }) };
};

const git = gitIn;

const noWorktree = (root: string) => {
  const dir = join(root, "projects", "demo");
  expect(git(dir, "worktree", "list", "--porcelain").split("worktree ").length - 1).toBe(1);
  expect(git(dir, "branch", "--list", "vibevalley/*").trim()).toBe("");
};

const occupied = (core: Core["Service"], runtime: string) =>
  core.apply({
    type: "session",
    session: {
      id: sessionId("occupied"),
      role: "worker",
      name: "occupied",
      agent: "x",
      runtime,
      brief: "",
      project: "demo",
      hiredAt: 0,
      runs: 0,
      phase: { _tag: "working", since: 0, doing: { action: "thinking", label: "" } },
      refining: false,
    },
  });

describe("issues", () => {
  it.effect("regression: responsibility starts before execution and changes only when the agent changes", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const issue = yield* issues.add({ title: "unstarted responsibility", agent: " lab ", project: "demo" });
      const original = (yield* issues.get(issue.id)).assignments;
      expect(original).toHaveLength(1);
      expect(original[0]).toMatchObject({ issue: issue.id, agent: "lab", executions: [] });
      expect(sessionIdsOf(issue)).toEqual([]);
      yield* TestClock.adjust(100);
      yield* issues.edit(issue.id, { title: "same responsibility", agent: "lab" }, owner);
      expect((yield* issues.get(issue.id)).assignments).toEqual(original);
      yield* issues.edit(issue.id, { agent: "lab2" }, owner);
      const reassigned = (yield* issues.get(issue.id)).assignments;
      expect(reassigned.map((a) => [a.agent, a.endedAt !== undefined, a.executions])).toEqual([
        ["lab", true, []],
        ["lab2", false, []],
      ]);
      expect(reassigned[0]?.id).toBe(original[0]?.id);
      expect(reassigned[0]?.endedAt).toBe(reassigned[1]?.assignedAt);
      yield* issues.edit(issue.id, { agent: "   " }, owner);
      expect((yield* issues.get(issue.id)).assignments.every((a) => a.endedAt !== undefined)).toBe(true);
      expect(assignedAgentOf(yield* issues.get(issue.id))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: an orchestrator owns several issues and repeated delivery keeps each responsibility", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const chat = yield* Channel;
      const first = yield* issues.add({ title: "first responsibility", agent: defaultOrchestrator });
      const second = yield* issues.add({ title: "second responsibility", agent: defaultOrchestrator });
      const before = (yield* issues.get(first.id)).assignments;
      yield* issues.start(first.id, chat.defaultChannel());
      yield* issues.start(second.id, chat.defaultChannel());
      const once = (yield* issues.get(first.id)).assignments;
      yield* issues.start(first.id, chat.defaultChannel());
      expect((yield* issues.get(first.id)).assignments).toEqual(once);
      expect(once[0]?.id).toBe(before[0]?.id);
      for (const issue of [first, second]) {
        const assignments = (yield* issues.get(issue.id)).assignments;
        expect(assignments).toHaveLength(1);
        expect(assignments[0]?.executions).toEqual([{ kind: "orchestrator", session: defaultOrchestrator, startedAt: expect.any(Number) }]);
        expect(sessionIdsOf(yield* issues.get(issue.id))).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: a rejected responsibility change keeps both the agent and assignment history", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sql = yield* SqlClient.SqlClient;
      const issue = yield* issues.add({ title: "atomic responsibility", agent: "lab" });
      const before = (yield* issues.get(issue.id)).assignments;
      const db = yield* Db;
      yield* db.run(
        sql.unsafe("create function reject_assignment() returns trigger language plpgsql as $$ begin raise exception 'assignment refused'; end $$"),
      );
      yield* db.run(sql.unsafe("create trigger reject_assignment before insert on issue_assignment for each row execute function reject_assignment()"));
      expect((yield* Effect.exit(issues.edit(issue.id, { agent: "lab2" }, owner)))._tag).toBe("Failure");
      expect(assignedAgentOf(yield* issues.get(issue.id))).toBe("lab");
      expect((yield* issues.get(issue.id)).assignments).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: completion and cancellation keep responsibility across new execution contexts", () => {
    const f = farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("结论：做完了") })]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const chat = yield* Channel;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "continued responsibility", agent: "lab", project: "demo" });
      const [original] = (yield* issues.get(issue.id)).assignments;
      const ready = (count: number) => waitFor(issues.get(issue.id), (i) => i.status === "in_review" && sessionIdsOf(i).length === count, "the next execution");
      yield* issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner);
      yield* ready(1);
      yield* issues.setStatus(issue.id, "done", "", chat.defaultChannel(), owner);
      yield* issues.setStatus(issue.id, "todo", "continue", chat.defaultChannel(), owner);
      yield* ready(2);
      yield* issues.setStatus(issue.id, "canceled", "", chat.defaultChannel(), owner);
      yield* issues.setStatus(issue.id, "todo", "continue again", chat.defaultChannel(), owner);
      yield* ready(3);
      const assignments = (yield* issues.get(issue.id)).assignments;
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.id).toBe(original?.id);
      expect(assignments[0]?.endedAt).toBeUndefined();
      expect(assignments[0]?.executions).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: deleting another issue while reassigning cannot restore a stale responsibility snapshot", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const issue = yield* issues.add({ title: "concurrent responsibility", agent: "lab" });
      for (let n = 0; n < 10; n++) {
        const disposable = yield* issues.add({ title: "discarded" });
        const agent = n % 2 === 0 ? "lab2" : "lab";
        yield* Effect.all([issues.remove(disposable.id), issues.edit(issue.id, { agent: agent }, owner)], { concurrency: 2 });
        const history = (yield* issues.get(issue.id)).assignments;
        expect(history).toHaveLength(n + 2);
        expect(history.filter((a) => a.endedAt === undefined).map((a) => a.agent)).toEqual([agent]);
        expect(assignedAgentOf(yield* issues.get(issue.id))).toBe(agent);
      }
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A budget: a board of twenty issues is one read of the table, and asks git nothing.
  it.live("listing twenty issues reads the database at most twice and runs no git", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const before = (yield* Metric.value(dbQueries)).count;
      for (let n = 1; n <= 20; n++) yield* issues.add({ title: `第 ${n} 件`, project: "demo" });
      // The counter counts: adding them asked the database.
      expect((yield* Metric.value(dbQueries)).count).toBeGreaterThan(before);
      const [queries, gits] = [(yield* Metric.value(dbQueries)).count, (yield* Metric.value(gitRuns)).count];
      expect((yield* issues.list()).length).toBe(20);
      const used = { queries: (yield* Metric.value(dbQueries)).count - queries, gits: (yield* Metric.value(gitRuns)).count - gits };
      expect(used.queries, JSON.stringify(used)).toBeLessThanOrEqual(2);
      expect(used.gits).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a prompt that starts then fails keeps the unclosed startup reserved", () => {
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
    const f = farm([runtime]);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all(cleanups.map((cleanup) => cleanup()));
        }),
      );
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const agent = { ...lab(), worktree: true };
      const first = yield* issues.hire(agent, "first work", "demo");
      expect(first.refused).toContain("prompt transport dropped");
      expect(first.refused).toContain("did not stop");
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      const issue = (yield* issues.list())[0]!;
      const second = yield* issues.hire(agent, "do not overlap", "demo", { issue: issue.id });
      expect(second.session).toBeUndefined();
      expect(turns).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a refused dispatch whose runtime cannot close keeps its workplace reserved", () => {
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
    const f = farm([runtime]);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all(cleanups.map((cleanup) => cleanup()));
        }),
      );
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("create function reject_link() returns trigger language plpgsql as $$ begin raise exception 'link refused'; end $$").pipe(Effect.orDie);
      yield* sql
        .unsafe("create trigger reject_link before insert on issue_assignment_execution for each row execute function reject_link()")
        .pipe(Effect.orDie);
      const agent = { ...lab(), worktree: true };
      expect((yield* issues.hire(agent, "first work", "demo")).refused).toContain("did not stop");
      const issue = (yield* issues.list())[0]!;
      expect(issue).toBeDefined();
      expect((yield* Effect.result(issues.remove(issue.id)))._tag).toBe("Failure");
      expect(existsSync(join(f.config.workRoot, "worktrees", "demo.1", "still-owned.txt"))).toBe(true);
      yield* sql.unsafe("drop trigger reject_link on issue_assignment_execution").pipe(Effect.orDie);
      const again = yield* issues.hire(agent, "do not overlap", "demo", { issue: issue.id });
      expect(again.session).toBeUndefined();
      expect(again.refused).toBeTruthy();
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(turns).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a refused dispatch keeps the identity of any work it already wrote", () => {
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
    const f = farm([worker]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("create function reject_link() returns trigger language plpgsql as $$ begin raise exception 'link refused'; end $$").pipe(Effect.orDie);
      yield* sql
        .unsafe("create trigger reject_link before insert on issue_assignment_execution for each row execute function reject_link()")
        .pipe(Effect.orDie);
      const agent = { ...lab(), worktree: true };
      expect((yield* issues.hire(agent, "first work", "demo")).refused).toContain("link refused");
      const kept = yield* issues.list();
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ number: 1, title: "first work", assignments: [{ agent: "lab", executions: [] }] });
      expect((yield* Effect.result(issues.edit(kept[0]!.id, { project: "elsewhere" }, owner)))._tag).toBe("Failure");
      expect((yield* issues.get(kept[0]!.id)).project).toBe("demo");
      expect((yield* Effect.result(issues.remove(kept[0]!.id)))._tag).toBe("Failure");
      expect((yield* issues.list()).map((i) => i.id)).toEqual([kept[0]!.id]);
      yield* sql.unsafe("drop trigger reject_link on issue_assignment_execution").pipe(Effect.orDie);
      const next = yield* issues.hire(agent, "unrelated work", "demo");
      expect(next.session?.branch).toBe("vibevalley/issue-2");
      yield* until(() => turns === 2, "the unrelated dispatch");
      expect(inherited).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a draft whose runtime refuses to stop keeps its session and workplace", () => {
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
    const f = farm([worker]);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => cleanup()));
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "draft", project: "demo", agent: "lab" });
      yield* issues.refine(issue.id, "keep reading", "");
      yield* until(() => started, "the writer");
      expect((yield* issues.get(issue.id)).assignments.map((a) => [a.agent, a.executions])).toEqual([["lab", []]]);
      const id = (yield* issues.get(issue.id)).refining!.session;
      const cwd = sessions.cwdOf(id)!;
      for (let n = 0; n < 2; n++) {
        const result = yield* Effect.result(issues.setStatus(issue.id, "canceled", "", "", owner));
        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result)).toContain("did not stop");
        expect(sessions.sessionOf(id)).toBeDefined();
        expect(existsSync(join(cwd, "still-owned.txt"))).toBe(true);
        expect(stopped).toBe(false);
      }
      expect(disposeCalls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("canceling a draft stops its writer before discarding the work", () => {
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
    const f = farm([worker]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "draft", project: "demo", agent: "lab" });
      yield* issues.refine(issue.id, "read the project", "");
      yield* until(() => started, "the drafting writer");
      yield* issues.setStatus(issue.id, "canceled", "", "", owner);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an immediate dispatch owns its issue's branch before the helper starts, and reopens it", () => {
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
    const f = farm([worker]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const hired = yield* issues.hire({ ...lab(), worktree: true }, "keep my work", "demo");
      expect(hired.session).toBeDefined();
      const first = hired.session!;
      yield* until(() => sessions.sessionOf(first.id)?.phase._tag === "done", "the dispatch's report");
      const issue = yield* issues.get(first.issue!);
      expect([first.branch, firstBranch]).toEqual([`vibevalley/issue-${issue.number}`, `vibevalley/issue-${issue.number}`]);
      const commit = git(first.worktree!, "rev-parse", "HEAD").trim();
      yield* issues.setStatus(issue.id, "canceled", "", "", owner);
      yield* waitFor(issues.get(issue.id), (i) => i.status === "canceled", "the canceled issue");
      const again = latestSessionIdOf(yield* issues.setStatus(issue.id, "todo", "keep going", "", owner));
      if (again === undefined) throw new Error("the issue has no reopened session");
      const reopened = sessions.sessionOf(again)!;
      expect([reopened.branch, reopened.worktree]).toEqual([first.branch, first.worktree]);
      expect(git(reopened.worktree!, "rev-parse", "HEAD").trim()).toBe(commit);
      expect(reopened.brief).toContain("这条分支上已经有上次的提交");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a session that cannot be opened gives its worktree back", () => {
    const f = farm();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const got = yield* sessions.send({ ...lab(), runtime: "missing-runtime", worktree: true }, "test", "demo", {
        context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
      });
      expect([got.session, got.refused !== undefined]).toEqual([undefined, true]);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: refused startup removes only the issue made for that dispatch and keeps an existing queue", () => {
    const f = farm([
      {
        ...busy,
        session: async () => {
          throw new Error("startup refused");
        },
      },
    ]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const core = yield* Core;
      const agent = { ...lab(), worktree: true };
      const refused = yield* issues.hire(agent, "new work", "demo");
      expect(refused.refused).toContain("startup refused");
      expect(yield* issues.list()).toEqual([]);
      expect(core.state().issues).toEqual([]);
      expect(sessions.presentSessions()).toEqual([]);
      noWorktree(f.config.workRoot);

      const existing = yield* issues.add({ title: "already queued", project: "demo", agent: agent.id });
      yield* occupied(core, "pi");
      yield* (yield* Agent).save(agent);
      const queued = yield* issues.setStatus(existing.id, "todo", "", "", owner);
      yield* core.apply({ type: "sessionGone", id: sessionId("occupied") });
      expect((yield* issues.hire(agent, "new attempt", "demo", { issue: existing.id })).refused).toContain("startup refused");
      const kept = yield* issues.get(existing.id);
      expect([kept.number, kept.queuedAt, sessionIdsOf(kept)]).toEqual([existing.number, queued.queuedAt, []]);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue that cannot be written publishes no session and keeps none", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      const sessions = yield* Session;
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .unsafe(`create function reject_issue() returns trigger language plpgsql as $$ begin raise exception 'test write failure'; end $$`)
        .pipe(Effect.orDie);
      yield* sql.unsafe(`create trigger reject_issue before insert on issue for each row execute function reject_issue()`).pipe(Effect.orDie);
      const got = yield* issues.hire({ ...lab(), worktree: true }, "test", "demo");
      expect(got.refused).toContain("test write failure");
      expect(got.session).toBeUndefined();
      expect([core.state().sessions.filter((s) => s.role === "worker").length, sessions.presentSessions().length]).toEqual([0, 0]);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("two sends at once honour the project's room", () => {
    const f = farm();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const core = yield* Core;
      const got = yield* Effect.all(
        [
          sessions.send(lab(), "test", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } }),
          sessions.send(lab(), "test", "demo", { context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } } }),
        ],
        { concurrency: "unbounded" },
      );
      expect(got.filter((h) => h.session !== undefined).length).toBe(1);
      expect(got.every((h) => h.session !== undefined || h.refused !== undefined)).toBe(true);
      expect(core.state().sessions.filter((s) => s.role === "worker")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an optional SQL row hides only absence, never a database failure", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sql = yield* SqlClient.SqlClient;
      const issue = yield* issues.add({ title: "read errors" });
      expect((yield* Effect.flip(issues.get("not-there")))._tag).toBe("Missing");
      yield* sql.unsafe("alter table issue rename to issue_broken").pipe(Effect.orDie);
      const out = yield* Effect.exit(issues.get(issue.id));
      expect(out._tag).toBe("Failure");
      if (out._tag === "Failure") expect(Cause.hasDies(out.cause)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a git failure cannot complete an issue as if it had no changes", () => {
    const worker = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        writeFileSync(join(turn.options.cwd, "committed.txt"), "work\n");
        git(turn.options.cwd, "add", "committed.txt");
        git(turn.options.cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "work");
        turn.say("结论：做完了");
      },
    });
    const f = farm([worker]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const chat = yield* Channel;
      yield* (yield* Agent).save(lab());
      const hired = yield* issues.hire({ ...lab(), worktree: true }, "keep my work", "demo");
      yield* until(() => sessions.sessionOf(hired.session!.id)?.phase._tag === "done", "the report");
      const repo = join(f.config.workRoot, "projects", "demo");
      renameSync(join(repo, ".git"), join(repo, ".git-hidden"));
      expect((yield* Effect.flip(issues.previewStatus(hired.session!.issue!, "done", "")))._tag).toBe("Refused");
      expect((yield* Effect.flip(issues.setStatus(hired.session!.issue!, "done", "", chat.defaultChannel(), owner)))._tag).toBe("Refused");
      const after = yield* issues.get(hired.session!.issue!);
      expect([after.status, after.delivered]).toEqual(["in_review", undefined]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue's actions act on its latest session", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const first = yield* issues.hire(lab(), "first", "demo");
      const id = first.session!.issue!;
      yield* sessions.dismiss(first.session!.id);
      const second = yield* issues.hire(lab(), "second", "demo", { issue: id });
      expect(second.session).toBeDefined();
      yield* issues.changes(id, owner);
      expect((yield* Effect.exit(issues.setStatus(id, "done", "", "", owner)))._tag).toBe("Failure");
      expect(sessions.sessionOf(second.session!.id)).toBeDefined();
      yield* issues.setStatus(id, "canceled", "", "", owner);
      expect(sessions.sessionOf(second.session!.id)).toBeUndefined();
      expect((yield* Effect.exit(issues.changes(id, owner)))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a queued issue keeps the channel it was first sent from", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      const chat = yield* Channel;
      const sessions = yield* Session;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agent).save(lab());
      const first = yield* chat.openChannel("first", "", "demo");
      const second = yield* chat.openChannel("second", "", "demo");
      yield* occupied(core, "pi");
      const issue = yield* issues.add({ title: "queued", agent: "lab", project: "demo" });
      for (const channel of [first.id, second.id]) expect((yield* issues.start(issue.id, channel)).queued).toBeDefined();
      yield* (yield* Issue).refreshQueue;
      expect(
        (yield* sql<{ channel: string }>`select t.trigger_json::jsonb->>'replyChannel' as channel
        from mailbox_issue m join ingress_trigger t on t.id = m.trigger_id where m.issue_id = ${issue.id} and m.state = 'held'`).map((r) => r.channel),
      ).toEqual([first.id]);
      yield* core.apply({ type: "sessionGone", id: sessionId("occupied") });
      const started = yield* issues.start(issue.id, second.id);
      expect(started.queued).toBeDefined();
      yield* (yield* Issue).refreshQueue;
      const got = yield* issues.get(issue.id);
      expect(sessionIdsOf(got)).toHaveLength(1);
      const queuedSession = sessionIdsOf(got)[0];
      if (queuedSession === undefined) throw new Error("the issue has no execution session");
      expect((yield* sessions.get(queuedSession))?.channel).toBe(first.id);
      yield* waitFor(sessions.issueRuns(issue.id), (r) => r.length > 0, "the queued run");
      expect((yield* sessions.issueRuns(issue.id))[0]!.triggeredBy.kind).toBe("issue");
      expect(yield* sql`select 1 from mailbox_issue where issue_id = ${issue.id} and state = 'held'`).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: requeueing uses the new source and retires the previous dispatch", () => {
    const inputs: string[] = [];
    const f = farm([
      scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          inputs.push(turn.input);
          turn.say("done");
        },
      }),
    ]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);

      const core = yield* Core;
      const chat = yield* Channel;
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const first = yield* chat.openChannel("queue-old", "", "demo");
      const second = yield* chat.openChannel("queue-new", "", "demo");
      yield* occupied(core, "pi");
      const item = yield* issues.add({ title: "queued", description: "old-dispatch-context", agent: "lab", project: "demo" });
      yield* issues.start(item.id, first.id);
      yield* (yield* Issue).refreshQueue;
      yield* issues.setStatus(item.id, "backlog", "", "", owner);
      yield* issues.edit(item.id, { description: "new-dispatch-context" }, owner);
      yield* issues.start(item.id, second.id);
      yield* (yield* Issue).refreshQueue;
      yield* core.apply({ type: "sessionGone", id: sessionId("occupied") });
      yield* (yield* Issue).refreshQueue;
      yield* until(() => inputs.length > 0, "the requeued input");
      expect(inputs[0]).toContain("new-dispatch-context");
      expect(inputs[0]).not.toContain("old-dispatch-context");
      const session = sessionIdsOf(yield* issues.get(item.id))[0]!;
      expect((yield* sessions.get(session))?.channel).toBe(second.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("a queued cron keeps its trigger and that it was missed", () => {
    const c = config();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      const chat = yield* Channel;
      const sessions = yield* Session;
      const crons = yield* Cron;
      yield* (yield* Agent).save(lab());
      const channel = yield* chat.openChannel("scheduled", "", "demo");
      yield* occupied(core, "pi");
      const sc = yield* crons.add({ name: "scheduled", text: "work", channel: channel.id, agent: "lab", when: { kind: "every", minutes: 1 } }, owner);
      yield* TestClock.adjust(10 * 60_000);
      yield* crons.tick;
      const issue = yield* waitFor(
        Effect.map(issues.list(), (all) => all.find((item) => item.cron === sc.id)),
        (item) => item?.queuedAt !== undefined,
        "the cron queued",
      );
      yield* core.apply({ type: "sessionGone", id: sessionId("occupied") });
      yield* (yield* Issue).refreshQueue;
      yield* waitFor(sessions.issueRuns(issue!.id), (r) => r.length > 0, "the scheduled run");
      const [run] = yield* sessions.issueRuns(issue!.id);
      expect(run!.triggeredBy).toEqual({ kind: "cron", cron: sc.id, missed: true, message: issue!.mandate.originTriggerId });
      expect((yield* sessions.get(run!.session))?.channel).toBe(channel.id);
    }).pipe(Effect.scoped, Effect.provide(world({ config: c, runtimes: [busy], repos: ["demo"] })));
  });

  it.live("a queued todo starts once there is room, and keeps its place until then", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      const chat = yield* Channel;
      yield* (yield* Agent).save(lab());
      yield* occupied(core, "pi");
      const issue = yield* issues.add({ title: "queued", agent: "lab", project: "demo" });
      expect((yield* issues.start(issue.id, chat.defaultChannel())).queued).toBeDefined();
      const queued = yield* issues.get(issue.id);
      yield* (yield* Issue).refreshQueue;
      const stillQueued = yield* issues.get(issue.id);
      expect([stillQueued.queuedAt, sessionIdsOf(stillQueued)]).toEqual([queued.queuedAt, []]);
      yield* core.apply({ type: "sessionGone", id: sessionId("occupied") });
      yield* (yield* Issue).refreshQueue;
      expect(sessionIdsOf(yield* issues.get(issue.id))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue handed over goes on in the same issue with another profile", () => {
    const f = farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") })]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const chat = yield* Channel;
      const agents = yield* Agent;
      yield* agents.save(lab());
      yield* agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
      const issue = yield* issues.add({ title: "write hello", agent: "lab", project: "demo" });
      const original = (yield* issues.get(issue.id)).assignments;
      const inReview = (n: number) => waitFor(issues.get(issue.id), (t) => t.status === "in_review" && sessionIdsOf(t).length === n, "round " + n);
      yield* issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner);
      yield* inReview(1);
      const [first] = sessionIdsOf(yield* issues.get(issue.id));
      const refused = (to: "done" | "todo", agent: string) =>
        Effect.map(Effect.flip(issues.setStatus(issue.id, to, "", chat.defaultChannel(), owner, { agent: agent })), reasonOf);
      expect(yield* refused("done", "lab2")).toContain("换人是挪到待办时的事");
      expect(yield* refused("todo", "nobody")).toContain("没有叫 nobody 的档案");

      const handed = yield* issues.setStatus(issue.id, "todo", "接着写", chat.defaultChannel(), owner, { agent: "Lab Two" });
      expect([assignedAgentOf(handed), sessionIdsOf(handed).length, handed.closedAt]).toEqual(["lab2", 2, undefined]);
      if (first === undefined) throw new Error("the issue has no first execution session");
      expect(sessions.sessionOf(first)).toBeUndefined();
      const next = sessionIdsOf(handed)[1];
      if (next === undefined) throw new Error("the issue has no second execution session");
      const second = (yield* sessions.get(next))!;
      expect(second.agent).toBe("lab2");
      expect(second.brief).toMatch(/^接着写\n\n（这张工单换你接手了，之前是 /u);
      yield* inReview(2);
      const assignments = (yield* issues.get(issue.id)).assignments;
      expect(assignments.map((a) => [a.agent, a.endedAt !== undefined, a.executions.map((e) => e.session)])).toEqual([
        ["lab", true, [first]],
        ["lab2", false, [second.id]],
      ]);
      expect(assignments[0]?.id).toBe(original[0]?.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue still being worked is not handed over", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const chat = yield* Channel;
      const agents = yield* Agent;
      yield* agents.save(lab());
      yield* agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
      const issue = yield* issues.add({ title: "work on", agent: "lab", project: "demo" });
      yield* issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner);
      yield* waitFor(issues.get(issue.id), (t) => t.status === "in_progress", "working");
      expect(reasonOf(yield* Effect.flip(issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner, { agent: "lab2" })))).toContain(
        "先叫停，等它停下再换人",
      );
      expect(sessionIdsOf(yield* issues.get(issue.id))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("history joins live and ended sessions", () => {
    const f = farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") })]);
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const issue = yield* issues.add({ title: "history", project: "demo", agent: "lab" });
      const first = (yield* issues.hire(lab(), "first", "demo", { issue: issue.id })).session!;
      yield* until(() => sessions.sessionOf(first.id)?.phase._tag === "done", "the first report");
      yield* sessions.dismiss(first.id);
      const live = (yield* issues.hire(lab(), "second", "demo", { issue: issue.id })).session!;
      yield* until(() => sessions.sessionOf(live.id)?.phase._tag === "done", "the live report");
      yield* sessions.suspend(live.id);
      const missing = (yield* issues.hire(lab(), "third", "demo", { issue: issue.id })).session!;
      yield* until(() => sessions.sessionOf(missing.id)?.phase._tag === "done", "the third report");
      yield* sessions.dismiss(missing.id);
      const [got] = yield* issues.history();
      expect(got!.sessions.map((s) => [s.id, s.phase._tag])).toEqual([
        [first.id, "closed"],
        [live.id, "done"],
        [missing.id, "closed"],
      ]);
      expect(got!.missingSessions).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
