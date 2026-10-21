import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import type { Agent, Session, TaskGraph } from "@vibevalley/protocol";
import { seedAgents } from "@vibevalley/protocol/rules";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Schedules } from "../schedule/schedule.ts";
import { Sessions } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { Issues } from "./issue.ts";

const lab = (): Agent => ({ ...seedAgents().find((a) => a.id === "lab")!, effort: "" });

/** A helper that works until it is stopped. */
const busy = scriptedRuntime({ id: "pi", turn: (turn) => new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve())) });

const config = () => {
  const c = testConfig();
  return { ...c, project: { ...c.project, maxSessions: 1 } };
};

const farm = (runtimes = [busy]) => {
  const c = config();
  return { config: c, layer: world({ config: c, runtimes, repos: ["demo"] }) };
};

const until = (ok: () => boolean | Promise<boolean>, what: string) =>
  Effect.promise(async () => {
    for (let i = 0; i < 500; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waited for ${what}`);
  });

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
  it.live("a session that cannot be opened gives its worktree back", () => {
    const f = farm();
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const got = yield* sessions.send({ ...lab(), runtime: "missing-runtime", worktree: true }, "test", "demo");
      expect([got.session, got.refused !== undefined]).toEqual([undefined, true]);
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
      const got = yield* Effect.all([sessions.send(lab(), "test", "demo"), sessions.send(lab(), "test", "demo")], { concurrency: "unbounded" });
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
      const graph = {
        id: "p1",
        title: "task",
        project: "demo",
        state: "draft",
        createdAt: 0,
        tasks: [
          { id: "a", title: "first", state: "waiting" },
          { id: "b", title: "second", state: "waiting" },
        ],
      } as unknown as TaskGraph;
      yield* issues.putTask(graph);
      const ranks = () => sql<{ id: string; rank: number }>`select id, rank from issue where id = 'p1' or parent = 'p1' order by id`.pipe(Effect.orDie);
      const before = yield* ranks();
      expect(before.length).toBeGreaterThan(0);
      yield* issues.move(one.id, "");
      expect(yield* ranks()).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("resolving says what git said when git fails", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const got = yield* issues.hire(lab(), "test", "demo");
      expect(got.session).toBeDefined();
      const repo = join(f.config.workRoot, "projects", "demo");
      renameSync(join(repo, ".git"), join(repo, ".git-hidden"));
      const err = yield* Effect.flip(issues.resolve(got.session!.issue!));
      expect(JSON.stringify(err)).not.toContain("没有冲突");
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
      yield* issues.changes(id, "owner");
      expect((yield* Effect.exit(issues.merge(id)))._tag).toBe("Failure");
      expect(sessions.find(second.session!.id)).toBeDefined();
      yield* issues.cancel(id);
      expect(sessions.find(second.session!.id)).toBeUndefined();
      expect((yield* Effect.exit(issues.changes(id, "owner")))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a queued issue keeps the channel it was first sent from", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      const sessions = yield* Sessions;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agents).saveAgent(lab());
      const first = yield* chat.openChannel("first", "", "demo");
      const second = yield* chat.openChannel("second", "", "demo");
      yield* occupied(core, "pi");
      const issue = yield* issues.add({ title: "queued", assignee: "lab", project: "demo" });
      for (const channel of [first.id, second.id]) expect((yield* issues.start(issue.id, channel)).queued).toBeDefined();
      expect((yield* sql<{ channel: string }>`select channel from issue_queue where issue = ${issue.id}`.pipe(Effect.orDie)).map((r) => r.channel)).toEqual([
        first.id,
      ]);
      yield* core.apply({ type: "left", id: "occupied" });
      const started = yield* issues.start(issue.id, second.id);
      expect(started.session).toBeDefined();
      const got = yield* issues.get(issue.id);
      expect(got.sessions).toHaveLength(1);
      expect((yield* sessions.get(got.sessions[0]!))?.channel).toBe(first.id);
      yield* until(() => Effect.runPromise(sessions.runs(issue.id)).then((r) => r.length > 0), "the queued run");
      expect((yield* sessions.runs(issue.id))[0]!.triggeredBy.kind).toBe("issue");
      expect(yield* sql`select 1 from issue_queue where issue = ${issue.id}`.pipe(Effect.orDie)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a queued schedule keeps its trigger and that it was missed", () => {
    const clock = { now: 1_800_000_000_000 };
    const c = config();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      const sessions = yield* Sessions;
      const schedules = yield* Schedules;
      yield* (yield* Agents).saveAgent(lab());
      const channel = yield* chat.openChannel("scheduled", "", "demo");
      yield* occupied(core, "pi");
      const sc = yield* schedules.add(
        { name: "scheduled", text: "work", channel: channel.id, agent: "lab", when: { kind: "every", minutes: 1 } },
        "owner",
        true,
      );
      // Ten minutes on, the tick finds it due, and missed.
      clock.now += 10 * 60_000;
      yield* schedules.tick;
      let issue = yield* issues.ofSchedule(sc.id);
      yield* until(async () => (issue = await Effect.runPromise(issues.ofSchedule(sc.id)))?.queuedAt !== undefined, "the schedule queued");
      yield* core.apply({ type: "left", id: "occupied" });
      yield* issues.tryQueued;
      yield* until(() => Effect.runPromise(sessions.runs(issue!.id)).then((r) => r.length > 0), "the scheduled run");
      const [run] = yield* sessions.runs(issue!.id);
      expect(run!.triggeredBy).toEqual({ kind: "schedule", schedule: sc.id, missed: true });
      expect((yield* sessions.get(run!.session))?.channel).toBe(channel.id);
    }).pipe(Effect.scoped, Effect.provide(world({ config: c, runtimes: [busy], repos: ["demo"], now: () => clock.now })));
  });

  it.live("a queued todo starts from the sowing form when there is room", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      yield* (yield* Agents).saveAgent(lab());
      yield* occupied(core, "pi");
      const issue = yield* issues.add({ title: "queued", assignee: "lab", project: "demo" });
      expect((yield* Effect.flip(issues.dispatchQueued(issue.id)))._tag).toBe("Refused");
      expect((yield* issues.start(issue.id, chat.general())).queued).toBeDefined();
      const queued = yield* issues.get(issue.id);
      const still = yield* issues.dispatchQueued(issue.id);
      expect([still.queued !== undefined, still.session]).toEqual([true, undefined]);
      expect((yield* issues.get(issue.id)).queuedAt).toBe(queued.queuedAt);
      yield* core.apply({ type: "left", id: "occupied" });
      expect((yield* issues.dispatchQueued(issue.id)).session).toBeDefined();
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
      const live = { id: "live", agent: "lab", name: "current", runtime: "pi", brief: "history", hiredAt: 3, runs: 0, phase: { _tag: "ripe" } } as Session;
      yield* core.apply({ type: "hired", session: live });
      for (const [id, at] of [
        ["ended", 1],
        ["live", 3],
        ["missing", 4],
      ] as const)
        yield* sql`insert into issue_session (session, issue, started_at) values (${id}, ${issue.id}, ${at})`.pipe(Effect.orDie);
      const [got] = yield* issues.history();
      expect(got!.sessions.map((s) => [s.id, s.phase._tag])).toEqual([
        ["ended", "closed"],
        ["live", "ripe"],
      ]);
      expect(got!.missingSessions).toEqual(["missing"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
