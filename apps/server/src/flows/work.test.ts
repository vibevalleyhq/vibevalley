import { existsSync } from "node:fs";
import { orchestrator, owner } from "../base/actor.ts";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { Fact, Session } from "@vibevalley/protocol";
import { needOf } from "@vibevalley/protocol/rules";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Core } from "../core/core.ts";
import { Issues } from "../issue/issue.ts";
import { Sessions, type SessionsInside } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { await_, farm, git, lab, mustHire, until, watch } from "./farm.ts";
import { releaseHeld } from "../testing/helper.ts";

const lastText = (sessions: Sessions, id: string, summary: string) => sessions.find(id)?.lastText ?? summary;

describe("a session's work", () => {
  it.live("is sent, works, reports and goes home", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const session = mustHire(yield* issues.hire(lab(), "写 hello.py", "demo"));
      const report = yield* w.nextReport;
      const text = lastText(sessions, report.id, report.summary);
      yield* sessions.dismiss(session.id);
      yield* until(() => w.facts.some((x) => x.type === "left"), "it went home");
      expect(report.outcome).toBe("completed");
      expect(text).toMatch(/做完了：写 hello\.py/);
      expect(text).toMatch(/原型/);
      // The farm's other news (its commits, the issue, the default channel and the owner's mentions in it) comes and goes beside the session's own.
      const mine = w.facts.filter((x) => !["commits", "issue", "message", "channel", "ownerMentions", "progress"].includes(x.type));
      expect([mine[0]!.type, mine.at(-1)!.type]).toEqual(["hired", "left"]);
      expect(mine.some((x) => x.type === "run")).toBe(true);
      expect(mine.some((x: Fact) => x.type === "doing" && x.action === "run_command" && x.label === "echo hi")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("is refused when it cannot be", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      expect((yield* issues.hire({ ...lab(), enabled: false }, "随便做点什么", "demo")).refused).toBe(lab().name + " 被停用了");
      expect((yield* issues.hire(lab(), "随便做点什么", "../../etc")).refused).toMatch(/不能当项目名/);
      expect((yield* issues.hire(lab(), "随便做点什么", "")).refused).toBeTruthy();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("is merged, and its worktree cleared", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const session = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const said = yield* issues.merge(session.issue!);
      expect(session.branch).toMatch(/^vibevalley\//);
      expect(said).toMatch(/1 个提交合进了 clock 的 main/);
      const project = join(f.config.workRoot, "projects", "clock");
      expect(git(project, "log", "--format=%s", "main")).toMatch(/加上打卡/);
      expect(existsSync(join(project, "clock.ts"))).toBe(true);
      expect(git(project, "worktree", "list").split("\n")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("goes in the ledger when merged", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sql = yield* SqlClient.SqlClient;
      const session = mustHire(yield* issues.hire(lab(), "写打卡并提交", "ledger"));
      yield* w.nextReport;
      yield* issues.merge(session.issue!);
      const entries = () =>
        Effect.runPromise(
          sql<{
            n: number;
          }>`select count(*)::int as n from game_ledger where kind = 'harvested' and payload like ${`%"session":"${session.id}"%`}`.pipe(Effect.orDie),
        ).then((r) => r[0]!.n);
      yield* until(async () => (await entries()) > 0, "a harvested entry");
      expect(yield* Effect.promise(entries)).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("comes back resting after a restart, and is woken", () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const before = farm({ config });
    let session: Session | undefined;
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const w = yield* watch;
        // Waking reads the agent from the store, as in real use: keep the script-friendly one there.
        yield* (yield* Agents).save(lab());
        session = mustHire(yield* (yield* Issues).hire(lab(), "先写一点并提交", "survivor"));
        yield* w.nextReport;
      }).pipe(Effect.scoped, Effect.provide(before.layer));
      const after = farm({ config });
      yield* Effect.gen(function* () {
        const w = yield* watch;
        const sessions = yield* Sessions;
        const back = sessions.find(session!.id)!;
        expect(back).toBeDefined();
        expect(back.session.phase._tag).toBe("done");
        expect(back.place.branch).toBe(session!.branch);
        expect(yield* sessions.tell(session!.id, "再加一句并提交", { kind: "comment" })).toMatch(/醒了/);
        yield* w.nextReport;
        expect(yield* (yield* Issues).merge(session!.issue!)).toMatch(/个提交合进了 survivor 的 main/);
      }).pipe(Effect.scoped, Effect.provide(after.layer));
    });
  });

  // What brings a session back is kept with its row: a database made again (a new schema) brings back no session, so no
  // plot is left on an issue that is gone.
  it.live("comes back only with the database it was kept in", () => {
    const base = testConfig();
    const before = farm({ config: { ...base, db: join(base.home, "db") } });
    let session: Session | undefined;
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const w = yield* watch;
        session = mustHire(yield* (yield* Issues).hire(lab(), "先写一点并提交", "survivor"));
        yield* w.nextReport;
      }).pipe(Effect.scoped, Effect.provide(before.layer));
      const after = farm({ config: { ...base, db: join(base.home, "db-again") } });
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions;
        const core = yield* Core;
        expect(sessions.find(session!.id)).toBeUndefined();
        expect(core.state().sessions.some((s) => s.id === session!.id)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(after.layer));
    });
  });

  it.live("keeps every step in its trajectory", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const session = mustHire(yield* issues.hire(lab(), "看看目录", "steps"));
      yield* w.nextReport;
      const steps = sessions.events(session.id)!;
      yield* sessions.dismiss(session.id);
      const after = (yield* sessions.get(session.id))!;
      expect([after.brief, after.agent, after.project, after.phase._tag]).toEqual(["看看目录", "lab", "steps", "closed"]);
      const want = ["run/start", "user/message", "tool/call", "tool/result", "assistant/message", "run/end"];
      const kept = sessions.events(session.id)!;
      expect(kept.map((e) => e.type)).toEqual(want);
      for (const e of kept) expect(e.run).toBe(kept[0]!.run);
      expect(kept.at(-1)!.text).toBe("completed");
      expect((yield* sessions.list("lab")).some((s) => s.id === session.id)).toBe(true);
      expect(steps.map((e) => e.type)).toEqual(want);
      expect(steps[1]!.text).toBe("看看目录");
      expect([steps[2]!.action, steps[2]!.text]).toEqual(["run_command", "echo hi"]);
      expect([steps[3]!.call, steps[3]!.output, steps[3]!.ok]).toEqual([steps[2]!.seq, "hi", true]);
      expect(steps[4]!.text).toMatch(/做完了：看看目录/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("that fails says why", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const session = mustHire(yield* issues.hire(lab(), "这一单必败", "fails"));
      const report = yield* w.nextReport;
      const text = lastText(sessions, report.id, report.summary);
      yield* sessions.dismiss(session.id);
      expect(report.outcome).toBe("failed");
      expect(text).toMatch(/provider said no/);
      expect(text).not.toContain('{"');
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("that goes quiet is flagged", () => {
    const f = farm({ stallMs: 500 });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const session = mustHire(yield* issues.hire(lab(), "先发呆一会儿", "quiet"));
      yield* until(() => {
        const need = needOf(sessions.find(session.id)!.session);
        return need?.kind === "quiet" && Date.now() - need.since >= 500;
      }, "the orchestrator sees it has been quiet half a second");
      yield* releaseHeld();
      yield* w.nextReport;
      const steps = sessions.events(session.id)!;
      yield* sessions.dismiss(session.id);
      expect(w.notes.some((s) => s.includes("没动静"))).toBe(true);
      expect(steps.some((s) => s.type === "run/error" && s.text.includes("没动静"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("shows its changes before a merge", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const session = mustHire(yield* issues.hire(lab(), "写打卡并提交", "preview"));
      yield* w.nextReport;
      const changes = yield* issues.changes(session.issue!, orchestrator(true));
      yield* sessions.dismiss(session.id);
      expect(changes.base).toBe("main");
      expect(changes.commits.map((c) => c.subject)).toEqual(["加上打卡"]);
      expect(changes.files.map((x) => [x.path, x.status, x.added])).toEqual([["clock.ts", "A", 1]]);
      expect(changes.files[0]!.patch).toMatch(/\+export const clockIn/);
      expect([changes.conflicts.length, changes.uncommitted.length]).toEqual([0, 0]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("on a conflicting branch stays until it is resolved", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      yield* (yield* Agents).save(lab());
      const a = mustHire(yield* issues.hire(lab(), "写版本A并提交", "clash"));
      const b = mustHire(yield* issues.hire(lab(), "写版本B并提交", "clash"));
      yield* w.nextReport;
      yield* w.nextReport;
      expect(yield* issues.merge(a.issue!)).toMatch(/个提交合进了 clash 的 main/);
      expect((yield* issues.changes(b.issue!, orchestrator(true))).conflicts).toEqual(["same.ts"]);
      const failed = yield* Effect.flip(issues.merge(b.issue!));
      expect(JSON.stringify(failed)).toMatch(/会冲突（same\.ts）/);
      const stayed = sessions.find(b.id)!;
      expect(stayed.session.conflict).toEqual({ base: "main", files: ["same.ts"] });
      yield* issues.setStatus(b.issue!, "todo", "", "", owner);
      yield* w.nextReport;
      // The round settled it: the sessions look at the mark again by themselves.
      yield* until(() => sessions.find(b.id)?.session.conflict === undefined, "the conflict mark cleared");
      expect(yield* issues.merge(b.issue!)).toMatch(/合进了 clash 的 main/);
      const project = join(f.config.workRoot, "projects", "clash");
      expect(git(project, "show", "main:same.ts")).toBe("export const v = 'A+B'");
      expect(git(project, "status", "--porcelain")).toBe("");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("is held to the project's and the runtime's limits", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const agents = yield* Agents;
      const busy: Session[] = [];
      for (const i of ["1", "2", "3"]) busy.push(mustHire(yield* issues.hire(lab(), "发呆 " + i, "crowded")));
      expect((yield* issues.hire(lab(), "发呆 4", "crowded")).refused).toMatch(/项目 crowded 里已经有 3 个帮工在干活/);
      const settings = agents.settings("pi");
      yield* agents.saveSettings("pi", { ...settings, maxWorking: 3 });
      expect((yield* issues.hire(lab(), "发呆 5", "roomy")).refused).toMatch(/最多同时 3 个/);
      yield* agents.saveSettings("pi", settings);
      yield* releaseHeld(3);
      for (let i = 0; i < 3; i++) yield* w.nextReport;
      const later = mustHire(yield* issues.hire(lab(), "随便做点什么", "crowded"));
      yield* w.nextReport;
      for (const h of [...busy, later]) yield* sessions.dismiss(h.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("two sent to a new project at once both work", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const both = yield* Effect.all([issues.hire(lab(), "随便做点什么", "twins"), issues.hire(lab(), "随便做点什么", "twins")], { concurrency: "unbounded" });
      for (const h of both) mustHire(h);
      yield* w.nextReport;
      yield* w.nextReport;
      expect(sessions.roster()).toHaveLength(2);
      for (const h of core.state().sessions) yield* sessions.dismiss(h.id);
      expect(sessions.roster()).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("speaks, ends, and its token goes with it", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const kinds: string[] = [];
      let id = "";
      yield* Effect.forkScoped(Stream.runForEach(yield* sessions.launches, (a) => Effect.sync(() => a.id === id && kinds.push(a.kind))));
      const session = mustHire(yield* issues.hire(lab(), "看看", "talk"));
      id = session.id;
      yield* until(() => kinds.includes("ended"), "the turn ended");
      expect(kinds.filter((k) => k === "spoke" || k === "ended")).toEqual(["spoke", "ended"]);
      const token = (sessions as SessionsInside).issueToken(session.id);
      expect(sessions.who(token)).toBe(session.id);
      expect((yield* sessions.deliver(session.id, "再看看", { kind: "comment" })).kind).toBe("run");
      yield* w.nextReport;
      yield* w.nextReport;
      yield* sessions.dismiss(session.id);
      expect(sessions.who(token)).toBe("");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("keeps what started each run, across a restart", () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const before = farm({ config });
    let session: Session | undefined;
    const said = { kind: "comment", message: "m42" } as const;
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const w = yield* watch;
        const sessions = yield* Sessions;
        yield* (yield* Agents).save(lab());
        session = mustHire(yield* (yield* Issues).hire(lab(), "写打卡并提交", "runs"));
        yield* w.nextReport;
        expect(yield* sessions.tell(session.id, "再看看", said)).toMatch(/新的一轮/);
        yield* w.nextReport;
        const got = yield* await_(
          () => sessions.runs(session!.issue!),
          (r) => r.length === 2 && r[1]!.endedAt !== undefined,
          "two runs ended",
        );
        expect([got[0]!.triggeredBy.kind, got[0]!.outcome]).toEqual(["issue", "completed"]);
        expect(got[1]!.triggeredBy).toEqual(said);
        yield* sessions.tell(session.id, "发呆一会儿", { kind: "comment" });
        yield* await_(
          () => sessions.runs(session!.issue!),
          (r) => r.length === 3,
          "a third run going",
        );
        expect((yield* sessions.deliver(session.id, "顺便看看", { kind: "comment", message: "m43" })).kind).toBe("steered");
        expect((yield* sessions.runs(session.issue!))[2]!.heard).toEqual(["m43"]);
      }).pipe(Effect.scoped, Effect.provide(before.layer));
      const after = farm({ config });
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions;
        expect((yield* sessions.runs(session!.issue!))[2]!.outcome).toBe("interrupted");
      }).pipe(Effect.scoped, Effect.provide(after.layer));
    });
  });

  // Whoever sees a session arrive can find its issue: the link is written before the session goes on the farm.
  it.live("has its issue there when it arrives", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const core = yield* Core;
      const found: boolean[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(yield* core.subscribe, (e) =>
          e.type === "hired" ? Effect.map(Effect.exit(issues.get(e.session.issue ?? e.session.id)), (x) => void found.push(x._tag === "Success")) : Effect.void,
        ),
      );
      mustHire(yield* issues.hire(lab(), "看看目录", "arrives"));
      yield* until(() => found.length > 0, "a session arrived");
      expect(found[0]).toBe(true);
      yield* w.nextReport;
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A session is a row from when it is sent: listed with the ones on the farm once it has ended, closed, its runs
  // counted.
  it.live("that ended is a row", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const s = mustHire(yield* issues.hire(lab(), "看看目录", "rows"));
      yield* w.nextReport;
      yield* sessions.dismiss(s.id);
      const got = (yield* sessions.get(s.id))!;
      expect([got.phase._tag, got.phase._tag === "closed" ? got.phase.closed : "", got.runs, got.lastRun !== undefined]).toEqual([
        "closed",
        "dismissed",
        1,
        true,
      ]);
      expect((yield* sessions.list("")).map((x) => x.id)).toEqual([s.id]);
      expect(yield* sessions.list("lab")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
