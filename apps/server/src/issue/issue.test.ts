import { execFileSync } from "node:child_process";
import { owner } from "../base/actor.ts";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import type { Agent, Session, TaskGraph } from "@vibevalley/protocol";
import { starter } from "../testing/layers.ts";
import { Cause, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { reasonOf } from "../errors.ts";
import { Crons } from "../cron/cron.ts";
import { Sessions } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { Issues } from "./issue.ts";
import { until } from "../testing/until.ts";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

const lab = (): Agent => ({ ...starter("lab"), effort: "" });

const busy = scriptedRuntime({ id: "pi", turn: (turn) => new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve())) });

const config = () => {
  const c = testConfig();
  return { ...c, project: { ...c.project, maxSessions: 1 } };
};

const farm = (runtimes = [busy]) => {
  const c = config();
  return { config: c, layer: world({ config: c, runtimes, repos: ["demo"] }) };
};

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const noWorktree = (root: string) => {
  const dir = join(root, "projects", "demo");
  expect(git(dir, "worktree", "list", "--porcelain").split("worktree ").length - 1).toBe(1);
  expect(git(dir, "branch", "--list", "vibevalley/*").trim()).toBe("");
};

const occupied = (core: Core["Service"], runtime: string) =>
  core.apply({
    type: "hired",
    session: {
      id: "occupied",
      name: "occupied",
      agent: "x",
      runtime,
      brief: "",
      project: "demo",
      hiredAt: 0,
      runs: 0,
      phase: { _tag: "working", doing: { action: "thinking", label: "" } },
    } as Session,
  });

describe("issues", () => {
  it.live("a prompt that starts then fails keeps the unclosed startup reserved", () => {
    let turns = 0;
    let wrote = () => {};
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
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
          for (const cleanup of cleanups) await cleanup();
        }),
      );
      const issues = yield* Issues;
      const sessions = yield* Sessions;
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
    let wrote = () => {};
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
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
          for (const cleanup of cleanups) await cleanup();
        }),
      );
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("create function reject_link() returns trigger language plpgsql as $$ begin raise exception 'link refused'; end $$").pipe(Effect.orDie);
      yield* sql.unsafe("create trigger reject_link before insert on issue_session for each row execute function reject_link()").pipe(Effect.orDie);
      const agent = { ...lab(), worktree: true };
      expect((yield* issues.hire(agent, "first work", "demo")).refused).toContain("did not stop");
      const issue = (yield* issues.list())[0]!;
      expect(issue).toBeDefined();
      expect((yield* Effect.result(issues.remove(issue.id)))._tag).toBe("Failure");
      expect(existsSync(join(f.config.workRoot, "worktrees", "demo.1", "still-owned.txt"))).toBe(true);
      yield* sql.unsafe("drop trigger reject_link on issue_session").pipe(Effect.orDie);
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
    let wrote = () => {};
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
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
      const issues = yield* Issues;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("create function reject_link() returns trigger language plpgsql as $$ begin raise exception 'link refused'; end $$").pipe(Effect.orDie);
      yield* sql.unsafe("create trigger reject_link before insert on issue_session for each row execute function reject_link()").pipe(Effect.orDie);
      const agent = { ...lab(), worktree: true };
      expect((yield* issues.hire(agent, "first work", "demo")).refused).toContain("link refused");
      const kept = yield* issues.list();
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ number: 1, title: "first work", sessions: [] });
      expect((yield* Effect.result(issues.edit(kept[0]!.id, { project: "elsewhere" }, owner)))._tag).toBe("Failure");
      expect((yield* issues.get(kept[0]!.id)).project).toBe("demo");
      expect((yield* Effect.result(issues.remove(kept[0]!.id)))._tag).toBe("Failure");
      expect((yield* issues.list()).map((i) => i.id)).toEqual([kept[0]!.id]);
      yield* sql.unsafe("drop trigger reject_link on issue_session").pipe(Effect.orDie);
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
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      yield* (yield* Agents).save(lab());
      const issue = yield* issues.add({ title: "draft", project: "demo", assignee: "lab" });
      yield* issues.refine(issue.id, "keep reading", "");
      yield* until(() => started, "the writer");
      const id = (yield* issues.get(issue.id)).refining!.session;
      const cwd = sessions.find(id)!.place.cwd;
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
      const issues = yield* Issues;
      yield* (yield* Agents).save(lab());
      const issue = yield* issues.add({ title: "draft", project: "demo", assignee: "lab" });
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
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      yield* (yield* Agents).save(lab());
      const hired = yield* issues.hire({ ...lab(), worktree: true }, "keep my work", "demo");
      expect(hired.session).toBeDefined();
      const first = hired.session!;
      yield* until(() => sessions.sessionOf(first.id)?.phase._tag === "done", "the dispatch's report");
      const issue = yield* issues.get(first.issue!);
      expect([first.branch, firstBranch]).toEqual([`vibevalley/issue-${issue.number}`, `vibevalley/issue-${issue.number}`]);
      const commit = git(first.worktree!, "rev-parse", "HEAD").trim();
      yield* issues.cancel(issue.id);
      yield* until(() => runPromise(issues.get(issue.id)).then((i) => i.status === "canceled"), "the canceled issue");
      const again = yield* issues.reopen(issue.id, "keep going", "");
      const reopened = sessions.sessionOf(again)!;
      expect([reopened.branch, reopened.worktree]).toEqual([first.branch, first.worktree]);
      expect(git(reopened.worktree!, "rev-parse", "HEAD").trim()).toBe(commit);
      expect(reopened.brief).toContain("这条分支上已经有上次的提交");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a session that cannot be opened gives its worktree back", () => {
    const f = farm();
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const got = yield* sessions.send({ ...lab(), runtime: "missing-runtime", worktree: true }, "test", "demo", { issue: { id: issueId("i1"), number: 1 } });
      expect([got.session, got.refused !== undefined]).toEqual([undefined, true]);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("refused startup removes only the issue made for that dispatch and keeps an existing queue", () => {
    const f = farm([
      {
        ...busy,
        session: async () => {
          throw new Error("startup refused");
        },
      },
    ]);
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const agent = { ...lab(), worktree: true };
      const refused = yield* issues.hire(agent, "new work", "demo");
      expect(refused.refused).toContain("startup refused");
      expect(yield* issues.list()).toEqual([]);
      expect(core.state().issues).toEqual([]);
      expect(sessions.roster()).toEqual([]);
      noWorktree(f.config.workRoot);

      const existing = yield* issues.add({ title: "already queued", project: "demo", assignee: agent.id });
      const queued = yield* issues.queue(existing.id, true);
      expect((yield* issues.hire(agent, "new attempt", "demo", { issue: existing.id })).refused).toContain("startup refused");
      const kept = yield* issues.get(existing.id);
      expect([kept.number, kept.queuedAt, kept.sessions]).toEqual([existing.number, queued.queuedAt, []]);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue that cannot be written publishes no session and keeps none", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const sessions = yield* Sessions;
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .unsafe(`create function reject_issue() returns trigger language plpgsql as $$ begin raise exception 'test write failure'; end $$`)
        .pipe(Effect.orDie);
      yield* sql.unsafe(`create trigger reject_issue before insert on issue for each row execute function reject_issue()`).pipe(Effect.orDie);
      const got = yield* issues.hire({ ...lab(), worktree: true }, "test", "demo");
      expect(got.refused).toContain("test write failure");
      expect(got.session).toBeUndefined();
      expect([core.state().sessions.length, sessions.roster().length]).toEqual([0, 0]);
      noWorktree(f.config.workRoot);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("two sends at once honour the project's room", () => {
    const f = farm();
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const got = yield* Effect.all(
        [
          sessions.send(lab(), "test", "demo", { issue: { id: issueId("i1"), number: 1 } }),
          sessions.send(lab(), "test", "demo", { issue: { id: issueId("i2"), number: 2 } }),
        ],
        { concurrency: "unbounded" },
      );
      expect(got.filter((h) => h.session).length).toBe(1);
      expect(got.every((h) => h.session || h.refused)).toBe(true);
      expect(core.state().sessions).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("moving an issue leaves a task's ranks alone", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const sql = yield* SqlClient.SqlClient;
      const one = yield* issues.add({ title: "one" });
      const graph: TaskGraph = {
        id: "p1",
        title: "task",
        goal: "task",
        project: "demo",
        state: "draft",
        parallel: 1,
        createdAt: 0,
        tasks: [
          { id: "a", title: "first", brief: "first", needs: [], state: "waiting", tries: 0 },
          { id: "b", title: "second", brief: "second", needs: ["a"], state: "waiting", tries: 0 },
        ],
      };
      yield* issues.putTask(graph);
      const ranks = () => sql<{ id: string; rank: number }>`select id, rank from issue where id = 'p1' or parent = 'p1' order by id`.pipe(Effect.orDie);
      const before = yield* ranks();
      expect(before.length).toBeGreaterThan(0);
      yield* issues.edit(one.id, { before: "" }, owner);
      expect(yield* ranks()).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an optional SQL row hides only absence, never a database failure", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
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
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const chat = yield* Channels;
      yield* (yield* Agents).save(lab());
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
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const first = yield* issues.hire(lab(), "first", "demo");
      const id = first.session!.issue!;
      yield* sessions.dismiss(first.session!.id);
      const second = yield* issues.hire(lab(), "second", "demo", { issue: id });
      expect(second.session).toBeDefined();
      yield* issues.changes(id, owner);
      expect((yield* Effect.exit(issues.merge(id)))._tag).toBe("Failure");
      expect(sessions.find(second.session!.id)).toBeDefined();
      yield* issues.cancel(id);
      expect(sessions.find(second.session!.id)).toBeUndefined();
      expect((yield* Effect.exit(issues.changes(id, owner)))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a queued issue keeps the channel it was first sent from", () => {
    const f = farm();
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      const sessions = yield* Sessions;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agents).save(lab());
      const first = yield* chat.openChannel("first", "", "demo");
      const second = yield* chat.openChannel("second", "", "demo");
      yield* occupied(core, "pi");
      const issue = yield* issues.add({ title: "queued", assignee: "lab", project: "demo" });
      for (const channel of [first.id, second.id]) expect((yield* issues.start(issue.id, channel)).queued).toBeDefined();
      expect((yield* sql<{ channel: string }>`select channel from issue_queue where issue = ${issue.id}`.pipe(Effect.orDie)).map((r) => r.channel)).toEqual([
        first.id,
      ]);
      yield* core.apply({ type: "left", id: sessionId("occupied") });
      const started = yield* issues.start(issue.id, second.id);
      expect(started.session).toBeDefined();
      const got = yield* issues.get(issue.id);
      expect(got.sessions).toHaveLength(1);
      expect((yield* sessions.get(got.sessions[0]!))?.channel).toBe(first.id);
      yield* until(() => runPromise(sessions.runs(issue.id)).then((r) => r.length > 0), "the queued run");
      expect((yield* sessions.runs(issue.id))[0]!.triggeredBy.kind).toBe("issue");
      expect(yield* sql`select 1 from issue_queue where issue = ${issue.id}`.pipe(Effect.orDie)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a queued cron keeps its trigger and that it was missed", () => {
    const clock = { now: 1_800_000_000_000 };
    const c = config();
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      const sessions = yield* Sessions;
      const crons = yield* Crons;
      yield* (yield* Agents).save(lab());
      const channel = yield* chat.openChannel("scheduled", "", "demo");
      yield* occupied(core, "pi");
      const sc = yield* crons.add({ name: "scheduled", text: "work", channel: channel.id, agent: "lab", when: { kind: "every", minutes: 1 } }, owner);
      clock.now += 10 * 60_000;
      yield* crons.tick;
      let issue = yield* issues.ofCron(sc.id);
      yield* until(async () => (issue = await runPromise(issues.ofCron(sc.id)))?.queuedAt !== undefined, "the cron queued");
      yield* core.apply({ type: "left", id: sessionId("occupied") });
      yield* issues.tryQueued;
      yield* until(() => runPromise(sessions.runs(issue!.id)).then((r) => r.length > 0), "the scheduled run");
      const [run] = yield* sessions.runs(issue!.id);
      expect(run!.triggeredBy).toEqual({ kind: "cron", cron: sc.id, missed: true });
      expect((yield* sessions.get(run!.session))?.channel).toBe(channel.id);
    }).pipe(Effect.scoped, Effect.provide(world({ config: c, runtimes: [busy], repos: ["demo"], clock: () => clock.now })));
  });

  it.live("a queued todo starts once there is room, and keeps its place until then", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      yield* (yield* Agents).save(lab());
      yield* occupied(core, "pi");
      const issue = yield* issues.add({ title: "queued", assignee: "lab", project: "demo" });
      expect((yield* issues.start(issue.id, chat.defaultChannel())).queued).toBeDefined();
      const queued = yield* issues.get(issue.id);
      yield* issues.tryQueued;
      expect([(yield* issues.get(issue.id)).queuedAt, (yield* issues.get(issue.id)).sessions]).toEqual([queued.queuedAt, []]);
      yield* core.apply({ type: "left", id: sessionId("occupied") });
      yield* issues.tryQueued;
      expect((yield* issues.get(issue.id)).sessions).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue handed over goes on in the same issue with another profile", () => {
    const f = farm([scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") })]);
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const chat = yield* Channels;
      const agents = yield* Agents;
      yield* agents.save(lab());
      yield* agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
      const issue = yield* issues.add({ title: "write hello", assignee: "lab", project: "demo" });
      const inReview = (n: number) =>
        until(() => runPromise(issues.get(issue.id)).then((t) => t.status === "in_review" && t.sessions.length === n), "round " + n);
      yield* issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner);
      yield* inReview(1);
      const [first] = (yield* issues.get(issue.id)).sessions;
      const refused = (to: "done" | "todo", agent: string) =>
        Effect.map(Effect.flip(issues.setStatus(issue.id, to, "", chat.defaultChannel(), owner, { assignee: agent })), reasonOf);
      expect(yield* refused("done", "lab2")).toContain("换人是挪到待办时的事");
      expect(yield* refused("todo", "nobody")).toContain("没有叫 nobody 的档案");

      const handed = yield* issues.setStatus(issue.id, "todo", "接着写", chat.defaultChannel(), owner, { assignee: "Lab Two" });
      expect([handed.assignee, handed.sessions.length, handed.closedAt]).toEqual(["lab2", 2, undefined]);
      expect(sessions.find(first!)).toBeUndefined();
      const second = (yield* sessions.get(handed.sessions[1]!))!;
      expect(second.agent).toBe("lab2");
      expect(second.brief).toMatch(/^接着写\n\n（这张工单换你接手了，之前是 /);
      yield* inReview(2);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("an issue still being worked is not handed over", () => {
    const f = farm();
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const issues = yield* Issues;
      const chat = yield* Channels;
      const agents = yield* Agents;
      yield* agents.save(lab());
      yield* agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
      const issue = yield* issues.add({ title: "work on", assignee: "lab", project: "demo" });
      yield* issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner);
      yield* until(() => runPromise(issues.get(issue.id)).then((t) => t.status === "in_progress"), "working");
      expect(reasonOf(yield* Effect.flip(issues.setStatus(issue.id, "todo", "", chat.defaultChannel(), owner, { assignee: "lab2" })))).toContain(
        "先叫停，等它停下再换人",
      );
      expect((yield* issues.get(issue.id)).sessions).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("history joins live and ended sessions, and names the missing", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const sql = yield* SqlClient.SqlClient;
      const issue = yield* issues.add({ title: "history" });
      yield* sql`insert into session (id, agent, name, runtime, brief, hired_at, ended_at, closed) values ('ended', 'lab', 'old', 'pi', 'history', 1, 2, 'merged')`.pipe(
        Effect.orDie,
      );
      const live = { id: "live", agent: "lab", name: "current", runtime: "pi", brief: "history", hiredAt: 3, runs: 0, phase: { _tag: "done" } } as Session;
      yield* core.apply({ type: "hired", session: live });
      // Through the issues, as a send records them: they are the only writer of issue_session.
      for (const [id, at] of [
        ["ended", 1],
        ["live", 3],
        ["missing", 4],
      ] as const)
        yield* issues.ran(issue.id, { ...live, id: sessionId(id), hiredAt: at });
      const [got] = yield* issues.history();
      expect(got!.sessions.map((s) => [s.id, s.phase._tag])).toEqual([
        ["ended", "closed"],
        ["live", "done"],
      ]);
      expect(got!.missingSessions).toEqual(["missing"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
