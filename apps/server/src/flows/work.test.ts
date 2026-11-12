import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { needOf } from "@vibevalley/protocol/rules";

import { orchestrator, user } from "#/base/actor.ts";
import { type Session } from "#/modules/session/session.ts";
import type { DeliveryInput } from "#/modules/session/signals.ts";
import { testConfig } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";
import { releaseHeld } from "#/testing/worker.ts";

import { await_, farm, type FlowWorld, git, lab, mustHire, until, watch, failure } from "./farm.ts";

const lastText = (sessions: Session, id: string, summary: string) => sessions.lastTextOf(id) || summary;
const delivery = (trigger: T.RunTrigger, envelopeIds: readonly string[] = []): DeliveryInput => ({ trigger, envelopeIds, byUserComment: false });

describe("a session's work", () => {
  test("is sent, works, reports and goes home", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "写 hello.py", "demo");
    const session = mustHire(hired);
    const report = await w.nextReport();
    const text = lastText(sessions, report.id, report.summary);
    await sessions.dismiss(session.id);
    await until(() => w.facts.some((x) => x.type === "sessionLeft"), "it went home");
    expect(report.outcome).toBe("completed");
    expect(text).toMatch(/做完了：写 hello\.py/u);
    expect(text).toMatch(/原型/u);
    // The farm's other news (its commits, the issue, the default channel and the user's mentions in it) comes and goes beside the session's own.
    const mine = w.facts.filter((x) => !["commits", "issueChanged", "messageChanged", "channelChanged", "userMentionsChanged", "progress"].includes(x.type));
    expect([mine[0]!.type, mine.at(-1)!.type]).toEqual(["sessionChanged", "sessionLeft"]);
    expect(mine.some((x) => x.type === "sessionPhaseChanged" && x.phase._tag === "working")).toBe(true);
    expect(
      mine.some(
        (x) => x.type === "sessionPhaseChanged" && x.phase._tag === "working" && x.phase.doing.action === "run_command" && x.phase.doing.label === "echo hi",
      ),
    ).toBe(true);
  });

  test("is refused when it cannot be", async () => {
    const f = farm();
    await using fw = await f.open();
    const issues = fw.issue;
    expect((await failure(issues.hire({ ...lab(), enabled: false }, "随便做点什么", "demo"))).reason).toBe(lab().name + " 被停用了");
    expect((await failure(issues.hire(lab(), "随便做点什么", "../../etc"))).reason).toMatch(/不能当仓库名/u);
    expect((await failure(issues.hire(lab(), "随便做点什么", ""))).reason).toBeTruthy();
  });

  test("is merged, and its worktree cleared", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const hired = await issues.hire(lab(), "写打卡并提交", "clock");
    const session = mustHire(hired);
    await w.nextReport();
    const said = await issues.setStatus(session.issue!, "done", "", "", user);
    expect(session.branch).toMatch(/^vibevalley\//u);
    expect(said).toMatchObject({ status: "done", delivered: "merged" });
    await until(() => w.notes.some((note) => /1 个提交合进了 clock 的 main/u.test(note)), "the merge notice");
    const repo = join(f.config.workRoot, "repos", "clock");
    expect(git(repo, "log", "--format=%s", "main")).toMatch(/加上打卡/u);
    expect(existsSync(join(repo, "clock.ts"))).toBe(true);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("goes in the ledger when merged", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sql = sqlOf(fw.db);
    const hired = await issues.hire(lab(), "写打卡并提交", "ledger");
    const session = mustHire(hired);
    await w.nextReport();
    await issues.setStatus(session.issue!, "done", "", "", user);
    const entries = () =>
      sql<{
        n: number;
      }>`select count(*) as n from game_ledger where kind = 'harvested' and payload like ${`%"session":"${session.id}"%`}`.then((r) => r[0]!.n);
    await until(async () => (await entries()) > 0, "a harvested entry");
    const entries2 = await entries();
    expect(entries2).toBe(1);
  });

  test("comes back resting after a restart, and is woken", async () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const before = farm({ config });
    let session: T.Session | undefined;
    {
      await using fw = await before.open();
      {
        const w = watch(fw);
        // Waking reads the agent from the store, as in real use: keep the script-friendly one there.
        await fw.agent.save(lab());
        const hired = await fw.issue.hire(lab(), "先写一点并提交", "survivor");
        session = mustHire(hired);
        await w.nextReport();
      }
    }

    const after = farm({ config });
    {
      await using fw = await after.open();
      const w = watch(fw);
      const sessions = fw.session;
      const back = sessions.sessionOf(session.id)!;
      expect(back).toBeDefined();
      expect(back.phase._tag).toBe("done");
      expect(back.branch).toBe(session.branch);
      const delivered2 = await sessions.deliver(session.id, "再加一句并提交", delivery({ kind: "comment" }));
      expect(delivered2).toMatchObject({ kind: "run", woke: true });
      await w.nextReport();
      const setStatus2 = await fw.issue.setStatus(session.issue!, "done", "", "", user);
      expect(setStatus2).toMatchObject({ status: "done", delivered: "merged" });
    }
  });

  // What brings a session back is kept with its row: a database made again (a new schema) brings back no session, so no
  // plot is left on an issue that is gone.
  test("comes back only with the database it was kept in", async () => {
    const base = testConfig();
    const before = farm({ config: { ...base, db: join(base.home, "db") } });
    let session: T.Session | undefined;
    {
      await using fw = await before.open();
      const w = watch(fw);
      const hired = await fw.issue.hire(lab(), "先写一点并提交", "survivor");
      session = mustHire(hired);
      await w.nextReport();
    }

    const after = farm({ config: { ...base, db: join(base.home, "db-again") } });
    {
      await using fw = await after.open();
      const sessions = fw.session;
      const core = fw.core;
      expect(sessions.sessionOf(session.id)).toBeUndefined();
      expect(core.state().sessions.some((s) => s.id === session.id)).toBe(false);
    }
  });

  test("works on the server's own machine, the same one after a restart", async () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    let first: T.Machine | undefined;
    // A farm on the same database, started for body and stopped after it.
    const started = async (body: (fw: FlowWorld) => Promise<void>) => {
      await using fw = await farm({ config }).open();
      await body(fw);
    };
    await started(async (fw) => {
      const w = watch(fw);
      first = fw.core.state().machines[0];
      expect(first).toMatchObject({ here: true, online: true });
      const hired = await fw.issue.hire(lab(), "先写一点并提交", "on-here");
      const session = mustHire(hired);
      expect(session.machine).toBe(first?.id);
      await w.nextReport();
    });
    await started(async (fw) => {
      expect(fw.core.state().machines).toEqual([first]);
    });
  });

  test("keeps every step in its trajectory", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "看看目录", "steps");
    const session = mustHire(hired);
    await w.nextReport();
    const steps = (await sessions.events(session.id)) ?? [];
    await sessions.dismiss(session.id);
    const after = (await sessions.get(session.id))!;
    expect([after.brief, after.agent, after.repo, after.phase._tag]).toEqual(["看看目录", "lab", "steps", "closed"]);
    const want = ["run/start", "user/message", "tool/call", "tool/result", "assistant/message", "run/end"];
    const kept = (await sessions.events(session.id)) ?? [];
    expect(kept.map((e) => e.type)).toEqual(want);
    for (const e of kept) expect(e.run).toBe(kept[0]!.run);
    expect(kept.at(-1)!.text).toBe("completed");
    expect((await sessions.list("lab")).some((s) => s.id === session.id)).toBe(true);
    expect(steps.map((e) => e.type)).toEqual(want);
    expect(steps[1]!.text).toBe("看看目录");
    expect([steps[2]!.action, steps[2]!.text]).toEqual(["run_command", "echo hi"]);
    expect([steps[3]!.call, steps[3]!.output, steps[3]!.ok]).toEqual([steps[2]!.seq, "hi", true]);
    expect(steps[4]!.text).toMatch(/做完了：看看目录/u);
  });

  test("that fails says why", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "这一单必败", "fails");
    const session = mustHire(hired);
    const report = await w.nextReport();
    const text = lastText(sessions, report.id, report.summary);
    await sessions.dismiss(session.id);
    expect(report.outcome).toBe("failed");
    expect(text).toMatch(/provider said no/u);
    expect(text).not.toContain('{"');
  });

  test("that goes quiet is flagged", async () => {
    const f = farm({ stallMs: 500 });
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "先发呆一会儿", "quiet");
    const session = mustHire(hired);
    await until(() => {
      const need = needOf(sessions.sessionOf(session.id)!);
      return need?.kind === "quiet" && Date.now() - need.since >= 500;
    }, "the orchestrator sees it has been quiet half a second");
    await releaseHeld();
    await w.nextReport();
    const steps = (await sessions.events(session.id)) ?? [];
    await sessions.dismiss(session.id);
    expect(w.notes.some((s) => s.includes("没动静"))).toBe(true);
    expect(steps.some((s) => s.type === "run/error" && s.text.includes("没动静"))).toBe(true);
  });

  test("shows its changes before a merge", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "写打卡并提交", "preview");
    const session = mustHire(hired);
    await w.nextReport();
    const changes = await issues.changes(session.issue!, orchestrator(true));
    await sessions.dismiss(session.id);
    expect(changes.base).toBe("main");
    expect(changes.commits.map((c) => c.subject)).toEqual(["加上打卡"]);
    expect(changes.files.map((x) => [x.path, x.status, x.added])).toEqual([["clock.ts", "A", 1]]);
    expect(changes.files[0]!.patch).toMatch(/\+export const clockIn/u);
    expect([changes.conflicts.length, changes.uncommitted.length]).toEqual([0, 0]);
  });

  test("on a conflicting branch stays until it is resolved", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    await fw.agent.save(lab());
    const hired = await issues.hire(lab(), "写版本A并提交", "clash");
    const a = mustHire(hired);
    const hired2 = await issues.hire(lab(), "写版本B并提交", "clash");
    const b = mustHire(hired2);
    await w.nextReport();
    await w.nextReport();
    const setStatus2 = await issues.setStatus(a.issue!, "done", "", "", user);
    expect(setStatus2).toMatchObject({ status: "done", delivered: "merged" });
    expect((await issues.changes(b.issue!, orchestrator(true))).conflicts).toEqual(["same.ts"]);
    const failed = await failure(issues.setStatus(b.issue!, "done", "", "", user));
    expect(JSON.stringify({ ...failed, name: failed.name, message: failed.message })).toMatch(/会冲突（same\.ts）/u);
    const stayed = await issues.get(b.issue!);
    expect(stayed.conflict).toEqual({ base: "main", files: ["same.ts"] });
    await issues.setStatus(b.issue!, "todo", "", "", user);
    await w.nextReport();
    // Issue rechecks its branch after the worker reports.
    const core = fw.core;
    await until(() => core.state().issues.find((issue) => issue.id === b.issue)?.conflict === undefined, "the conflict mark cleared");
    const setStatus3 = await issues.setStatus(b.issue!, "done", "", "", user);
    expect(setStatus3).toMatchObject({ status: "done", delivered: "merged" });
    const repo = join(f.config.workRoot, "repos", "clash");
    expect(git(repo, "show", "main:same.ts")).toBe("export const v = 'A+B'");
    expect(git(repo, "status", "--porcelain")).toBe("");
    await until(() => core.state().progress?.counts.untangle === 1, "the issue conflict credited to its resolver");
  });

  test("regression: an issue keeps its conflict after its session closes and the server restarts", async () => {
    const config = testConfig({ db: "" });
    const f = farm({ config });
    const id = await (async () => {
      await using fw = await f.open();
      const w = watch(fw);
      const issues = fw.issue;
      await fw.agent.save(lab());
      const hired = await issues.hire(lab(), "写版本A并提交", "persistent-conflict");
      const first = mustHire(hired);
      const hired2 = await issues.hire(lab(), "写版本B并提交", "persistent-conflict");
      const second = mustHire(hired2);
      await w.nextReport();
      await w.nextReport();
      await issues.setStatus(first.issue!, "done", "", "", user);
      await issues.changes(second.issue!, user);
      await fw.session.dismiss(second.id);
      expect((await issues.get(second.issue!)).conflict).toEqual({ base: "main", files: ["same.ts"] });
      expect(Object.hasOwn((await fw.session.get(second.id))!, "conflict")).toBe(false);
      return second.issue!;
    })();
    {
      await using fw = await farm({ config }).open();
      expect((await fw.issue.get(id)).conflict).toEqual({ base: "main", files: ["same.ts"] });
      expect((await fw.issue.changes(id, user)).conflicts).toEqual(["same.ts"]);
    }
  });

  test("is held to the repo's and the runtime's limits", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const agents = fw.agent;
    const busy: T.Session[] = [];
    for (const i of ["1", "2", "3"]) {
      const idle = await issues.hire(lab(), "发呆 " + i, "crowded");
      busy.push(mustHire(idle));
    }
    expect((await failure(issues.hire(lab(), "发呆 4", "crowded"))).reason).toMatch(/仓库 crowded 里已经有 3 个帮工在干活/u);
    const settings = agents.settings("pi");
    await agents.saveSettings("pi", { ...settings, maxWorking: 3 });
    expect((await failure(issues.hire(lab(), "发呆 5", "roomy"))).reason).toMatch(/最多同时 3 个/u);
    await agents.saveSettings("pi", settings);
    await releaseHeld(3);
    for (let i = 0; i < 3; i++) await w.nextReport();
    const hired = await issues.hire(lab(), "随便做点什么", "crowded");
    const later = mustHire(hired);
    await w.nextReport();
    for (const h of [...busy, later]) await sessions.dismiss(h.id);
  });

  test("two sent to a new repo at once both work", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const core = fw.core;
    const both = await Promise.all([issues.hire(lab(), "随便做点什么", "twins"), issues.hire(lab(), "随便做点什么", "twins")]);
    for (const h of both) mustHire(h);
    await w.nextReport();
    await w.nextReport();
    expect(sessions.hired()).toHaveLength(2);
    for (const h of core.state().sessions) await sessions.dismiss(h.id);
    expect(sessions.hired()).toHaveLength(0);
  });

  test("speaks, ends, and its token goes with it", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const kinds: string[] = [];
    let id = "";
    using news = sessions.news();
    // The reader ends with its subscription, as the test ends.
    (async () => {
      for await (const n of news) if ((n._tag === "Spoke" || n._tag === "HandedOff") && n.id === id) kinds.push(n._tag);
    })().catch(() => {});
    const hired = await issues.hire(lab(), "看看", "talk");
    const session = mustHire(hired);
    id = session.id;
    await until(() => kinds.includes("HandedOff"), "the turn handed off");
    expect(kinds).toEqual(["Spoke", "HandedOff"]);
    const server = f.turns[0]!.options.mcpServers?.find((server) => server.name === "vibevalley");
    if (!server || !("headers" in server)) throw new Error("the runtime received no authenticated MCP endpoint");
    const token = server.headers?.authorization?.replace("Bearer ", "") ?? "";
    expect(sessions.who(token)).toBe(session.id);
    expect((await sessions.deliver(session.id, "再看看", delivery({ kind: "comment" }))).kind).toBe("run");
    await w.nextReport();
    await w.nextReport();
    await sessions.dismiss(session.id);
    expect(sessions.who(token)).toBe("");
  });

  test("keeps what started each run, across a restart", async () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const before = farm({ config });
    let session: T.Session | undefined;
    const said = { kind: "comment", message: "m42" } as const;
    {
      await using fw = await before.open();
      {
        const w = watch(fw);
        const sessions = fw.session;
        await fw.agent.save(lab());
        const hired = await fw.issue.hire(lab(), "写打卡并提交", "runs");
        session = mustHire(hired);
        await w.nextReport();
        expect((await sessions.deliver(session.id, "再看看", delivery(said, ["m42"]))).kind).toBe("run");
        await w.nextReport();
        const got = await await_(
          () => sessions.issueRuns(session.issue!),
          (r) => r.length === 2 && r[1]!.endedAt !== undefined,
          "two runs ended",
        );
        expect([got[0]!.triggeredBy.kind, got[0]!.outcome]).toEqual(["issue", "completed"]);
        expect(got[1]!.triggeredBy).toEqual(said);
        await sessions.deliver(session.id, "发呆一会儿", delivery({ kind: "comment" }));
        await await_(
          () => sessions.issueRuns(session.issue!),
          (r) => r.length === 3,
          "a third run going",
        );
        expect((await sessions.deliver(session.id, "顺便看看", delivery({ kind: "comment", message: "m43" }, ["m43"]))).kind).toBe("steered");
        // A run's heard is recorded behind the steer (recordRun), so it is waited for.
        await await_(
          () => sessions.issueRuns(session.issue!),
          (r) => r[2]?.heard.includes("m43") === true,
          "the steered message heard",
        );
      }
    }

    const after = farm({ config });
    {
      await using fw = await after.open();
      const sessions = fw.session;
      expect((await sessions.issueRuns(session.issue!))[2]!.outcome).toBe("interrupted");
    }
  });

  // Whoever sees a session arrive can find its issue: the link is written before the session goes on the farm.
  test("has its issue there when it arrives", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const core = fw.core;
    const found: boolean[] = [];
    using subscribe2 = core.subscribe();
    // The reader ends with its subscription, as the test ends.
    (async () => {
      for await (const e of subscribe2)
        if (e.type === "sessionChanged")
          found.push(
            await issues.get(e.session.issue ?? e.session.id).then(
              () => true,
              () => false,
            ),
          );
    })().catch(() => {});
    const hired = await issues.hire(lab(), "看看目录", "arrives");
    mustHire(hired);
    await until(() => found.length > 0, "a session arrived");
    expect(found[0]).toBe(true);
    await w.nextReport();
  });

  // A session is a row from when it is sent: listed with the ones on the farm once it has ended, closed, its runs
  // counted.
  test("that ended is a row", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "看看目录", "rows");
    const s = mustHire(hired);
    await w.nextReport();
    await sessions.dismiss(s.id);
    const got = (await sessions.get(s.id))!;
    expect([got.phase._tag, got.phase._tag === "closed" ? got.phase.closed : "", got.runs, got.lastRun !== undefined]).toEqual([
      "closed",
      "dismissed",
      1,
      true,
    ]);
    expect((await sessions.list("")).filter((session) => session.role === "worker").map((session) => session.id)).toEqual([s.id]);
    expect((await sessions.list("")).some((session) => session.role === "orchestrator")).toBe(true);
    const sessions2 = await sessions.list("lab");
    expect(sessions2).toHaveLength(1);
  });
});
