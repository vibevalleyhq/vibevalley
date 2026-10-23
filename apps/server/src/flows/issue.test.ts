import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { AccountUsage, Issue, Session } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { openFindings } from "../issue/state.ts";
import { messagesIn } from "../channel/state.ts";
import { viewOf } from "../game/view.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Issues } from "../issue/issue.ts";
import { Runtimes } from "../runtime/runtime.ts";
import { Recurrences } from "../recurrence/recurrence.ts";
import { Sessions, type SessionsInside } from "../session/session.ts";
import { write } from "../testing/git.ts";
import { await_, farm, git, lab, mustHire, until, watch } from "./farm.ts";

const refusedWith = (e: unknown, words = "") => {
  const tagged = e as { _tag?: string; reason?: string };
  expect(tagged._tag).toBe("Refused");
  if (words) expect(tagged.reason).toContain(words);
};

describe("an issue", () => {
  // Done is the owner's verdict; what it delivers follows the issue: nothing to take in touches no git, a branch can be
  // kept unmerged, and only commits go into the main branch.
  it.live("completes by what it delivers: nothing, a kept branch, or a merge", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      yield* (yield* Agents).saveAgent(lab());
      const project = join(f.config.workRoot, "projects", "clock");
      const closed = (id: string) =>
        await_(
          () => issues.get(id),
          (i) => i.closedAt !== undefined,
          "closed",
        );
      const left = (id: string) =>
        await_(
          () => sessions.get(id),
          (s) => s?.phase._tag === "closed",
          "gone home",
        );
      const mainLog = () => git(project, "log", "--format=%s", "main");

      const looked = mustHire(yield* issues.hire(lab(), "看看打卡页", "clock"));
      yield* w.nextReport;
      const before = mainLog();
      yield* issues.setStatus(looked.issue!, "done", "", "");
      const nothing = yield* closed(looked.issue!);
      expect([nothing.status, nothing.delivered, nothing.canceled]).toEqual(["done", "none", undefined]);
      const gone = yield* left(looked.id);
      expect(gone?.phase._tag === "closed" && gone.phase.closed).toBe("completed");
      expect(mainLog()).toBe(before);

      const kept = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const keptIssue = yield* issues.get(kept.issue!);
      yield* issues.act(kept.issue!, { act: "keep" }, "");
      expect((yield* closed(kept.issue!)).delivered).toBe("kept");
      yield* left(kept.id);
      expect(mainLog()).toBe(before);
      expect(git(project, "branch", "--list", `vibevalley/issue-${keptIssue.number}`)).not.toBe("");

      const completed = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      yield* issues.setStatus(completed.issue!, "done", "", "");
      expect((yield* closed(completed.issue!)).delivered).toBe("merged");
      expect(mainLog()).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("closes and reopens", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agents).saveAgent(lab());
      const session = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock-in"));
      expect(session.issue).toBeTruthy();
      yield* w.nextReport;
      refusedWith(yield* Effect.flip(issues.reopen(session.id, "", "")));
      yield* issues.merge(session.issue!);
      const ended = (yield* sessions.get(session.id))!;
      expect([ended.phase._tag === "closed" && ended.phase.closed, ended.lastRun?.outcome, !!ended.lastRun?.summary, ended.runs, ended.issue]).toEqual([
        "merged",
        "completed",
        true,
        1,
        session.issue,
      ]);
      const closedAs = (how: string) =>
        await_(
          () => issues.get(session.issue!),
          (i) => (i.delivered ?? i.canceled) === how,
          `closed as ${how}`,
        );
      yield* closedAs("merged");

      const again = yield* issues.reopen(session.id, "打卡还要记下时区", "");
      yield* w.nextReport;
      const issue = yield* issues.get(again);
      expect([issue.id, issue.sessions, issue.delivered, issue.canceled, issue.closedAt]).toEqual([
        session.issue,
        [session.id, again],
        undefined,
        undefined,
        undefined,
      ]);
      const reopened = (yield* sessions.get(again))!;
      expect(reopened.brief).toMatch(new RegExp(`^打卡还要记下时区\\n\\n（这张工单重开了，上一次是 .+（${session.id}）做的。）`));
      expect(reopened.brief).toMatch(/这张工单原来是：写打卡并提交\n它是怎么关的：已完成，合进了主分支/);
      refusedWith(yield* Effect.flip(issues.reopen(session.issue!, "", "")));
      expect((yield* Effect.flip(issues.reopen("w404", "", "")))._tag).toBe("Missing");
      yield* sessions.dismiss(again);
      yield* closedAs("dismissed");
      yield* sql`update issue set delivered = 'merged_into_parent', canceled = null, closed_at = ${Date.now()} where id = ${issue.id}`.pipe(Effect.orDie);
      refusedWith(yield* Effect.flip(issues.reopen(issue.id, "", "")), "计划里的工单");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("written down is started, edited, and ordered", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      refusedWith(yield* Effect.flip(issues.add({ title: "  " })));
      let issue = yield* issues.add({ title: "写打卡并提交" });
      expect(issue.status).toBe("backlog");
      const inState = (id: string) => core.state().issues?.find((x) => x.id === id);
      expect(inState(issue.id)?.title).toBe("写打卡并提交");
      refusedWith(yield* Effect.flip(issues.start(issue.id, "")));
      issue = yield* issues.edit(issue.id, { project: "backlog", assignee: "lab" });
      expect([issue.project, issue.assignee]).toEqual(["backlog", "lab"]);
      const got = yield* issues.start(issue.id, "");
      expect(got.session).toBeDefined();
      yield* w.nextReport;
      expect((yield* sessions.get(got.session!))!.brief).toBe("写打卡并提交");
      const started = yield* issues.get(issue.id);
      expect([started.sessions, started.status]).toEqual([[got.session], "in_review"]);
      yield* until(() => inState(issue.id)?.sessions?.length === 1 && inState(issue.id)?.status === "in_review", "the core state follows its run");
      refusedWith(yield* Effect.flip(issues.start(issue.id, "")));
      refusedWith(yield* Effect.flip(issues.edit(issue.id, { title: "改不了了" })));

      const unsent = (all: Issue[]) => all.filter((i) => (i.sessions ?? []).length === 0).map((i) => i.title);
      const a = yield* issues.add({ title: "一" });
      const b = yield* issues.add({ title: "二", priority: "urgent" });
      const c = yield* issues.add({ title: "三" });
      expect([a.priority, b.priority]).toEqual(["medium", "urgent"]);
      expect(unsent(yield* issues.move(c.id, a.id))).toEqual(["三", "一", "二"]);
      expect(unsent(yield* issues.move(c.id, ""))).toEqual(["一", "二", "三"]);
      const d = yield* issues.add({ title: "四" });
      const all = yield* issues.list();
      expect(unsent(all)[3]).toBe(d.title);
      expect(all.at(-1)!.id).toBe(issue.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("waits for room", () => {
    const f = farm({ change: (c) => ({ ...c, project: { ...c.project, maxSessions: 1 } }) });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      yield* core.apply({
        type: "hired",
        session: {
          id: "w90",
          name: "占地的",
          agent: "lab",
          runtime: "pi",
          brief: "先干着",
          project: "queue",
          hiredAt: 0,
          runs: 0,
          phase: { _tag: "working", since: Date.now(), doing: { action: "none", label: "" } },
        } as Session,
      });
      const issue = yield* issues.add({ title: "等空位的活", project: "queue", assignee: "lab" });
      const got = yield* issues.start(issue.id, "");
      expect(got.session).toBeUndefined();
      expect(got.queued).toContain("排上队了");
      const status = () => Effect.map(issues.get(issue.id), (i) => i.status);
      expect(yield* status()).toBe("todo");
      yield* issues.tryQueued;
      expect(yield* status()).toBe("todo");
      yield* core.apply({ type: "left", id: "w90" });
      yield* issues.tryQueued;
      yield* w.nextReport;
      expect(yield* status()).toBe("in_review");
      expect((yield* sessions.list("lab")).some((s) => s.brief === "等空位的活")).toBe(true);
      const other = yield* issues.add({ title: "别排了" });
      const queued = yield* issues.queue(other.id, true);
      const unqueued = yield* issues.queue(other.id, false);
      expect([queued.queuedAt !== undefined, unqueued.queuedAt]).toEqual([true, undefined]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("knows its task", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const session = mustHire(yield* (yield* Issues).hire(lab(), "做一步", "split", { taskGraph: { id: "p1", task: "impl" } }));
      const head = (yield* (yield* Sessions).get(session.id))!;
      expect(head.graph).toEqual({ id: "p1", task: "impl" });
      yield* w.nextReport;
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("of a recurrence is one, told again and reopened", () => {
    let now = Date.now();
    const f = farm({ now: () => now });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const recurrences = yield* Recurrences;
      yield* (yield* Agents).saveAgent({ ...lab(), enabled: true });
      const made = yield* recurrences.add({ name: "巡检", text: "看一眼", agent: "lab", project: "every", when: { kind: "every", minutes: 5 } }, "owner", true);
      const due = () => {
        now += 5 * 60_000 + 1;
        return recurrences.tick;
      };
      const ofRecurrence = () => Effect.map(issues.ofRecurrence(made.id), (i) => i!);
      const runs = () => Effect.flatMap(ofRecurrence(), (i) => sessions.runs(i.id));
      yield* due();
      yield* w.nextReport;
      const first = yield* ofRecurrence();
      expect(first.sessions).toHaveLength(1);

      yield* due();
      yield* w.nextReport;
      expect((yield* ofRecurrence()).id).toBe(first.id);
      expect((yield* ofRecurrence()).sessions).toHaveLength(1);
      const two = yield* await_(runs, (r) => r.length === 2 && r[1]!.endedAt !== undefined, "a second run");
      expect(two[1]!.triggeredBy.kind).toBe("recurrence");

      yield* issues.merge(first.id);
      yield* await_(ofRecurrence, (i) => i.status === "done", "merged");
      yield* due();
      yield* w.nextReport;
      expect((yield* ofRecurrence()).id).toBe(first.id);
      expect((yield* ofRecurrence()).sessions).toHaveLength(2);
      const three = yield* await_(runs, (r) => r.length === 3, "a third run");
      expect(three[2]!.triggeredBy.kind).toBe("recurrence");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("update changes only what it gives", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      let issue = yield* issues.add({ title: "写打卡", description: "每天一次", project: "demo", assignee: "lab", priority: "high" });
      issue = yield* issues.edit(issue.id, { title: "写打卡并提交" });
      expect([issue.title, issue.description, issue.project, issue.assignee, issue.priority]).toEqual(["写打卡并提交", "每天一次", "demo", "lab", "high"]);
      issue = yield* issues.edit(issue.id, { project: "" });
      expect([issue.project, issue.assignee]).toEqual([undefined, "lab"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // The owner only moves the issue: todo sends it out, todo again is another round, done merges; the dropped one comes back.
  it.live("is worked by moving it", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      yield* (yield* Agents).saveAgent(lab());
      const move = (id: string, to: Issue["status"], text = "") => issues.setStatus(id, to, text, "");
      let issue = yield* issues.add({ title: "写打卡并提交", project: "clock", assignee: "lab" });
      expect(issue.moves).toEqual(["todo", "canceled"]);
      refusedWith(yield* Effect.flip(move(issue.id, "in_progress")));
      issue = yield* move(issue.id, "todo");
      yield* w.nextReport;
      issue = yield* issues.get(issue.id);
      expect([issue.status, issue.moves]).toEqual(["in_review", ["todo", "done", "canceled"]]);
      refusedWith(yield* Effect.flip(move(issue.id, "todo", " ")));
      yield* move(issue.id, "todo", "再写版本B");
      yield* w.nextReport;
      issue = yield* move(issue.id, "done");
      expect(issue.status).toBe("done");
      expect(git(join(f.config.workRoot, "projects", "clock"), "log", "--format=%s", "main")).toMatch(/版本 B/);
      expect(issue.moves).toEqual(["todo"]);

      let dropped = yield* issues.add({ title: "算了" });
      dropped = yield* move(dropped.id, "canceled");
      expect([dropped.status, dropped.canceled]).toEqual(["canceled", "dismissed"]);
      dropped = yield* move(dropped.id, "backlog");
      expect(dropped.status).toBe("backlog");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("moved to done is refused when the project's check fails", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      yield* (yield* Agents).saveAgent(lab());
      const helper = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const place = (sessions as SessionsInside).place(helper.id)!;
      mkdirSync(join(place.cwd, ".vibevalley"), { recursive: true });
      write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\necho merge-check-failed\nexit 1\n", 0o755);
      const project = join(f.config.workRoot, "projects", "clock");
      const before = git(project, "rev-parse", "main");
      refusedWith(yield* Effect.flip(issues.setStatus(helper.issue!, "done", "", "")), "merge-check-failed");
      expect((yield* issues.get(helper.issue!)).status).toBe("in_review");
      yield* until(() => {
        const got = sessions.find(helper.id);
        return got !== undefined && got.lastText.includes("merge-check-failed") && !isBusy(got.session);
      }, "the helper hears the check's output");
      expect((yield* issues.get(helper.issue!)).status).toBe("in_review");
      expect(git(project, "rev-parse", "main")).toBe(before);
      expect(existsSync(place.cwd)).toBe(true);
      git(project, "rev-parse", "--verify", place.branch!);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("keeps its worktree when cancelled and reopened", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      yield* (yield* Agents).saveAgent(lab());
      const issue = yield* issues.add({ title: "写打卡并提交", project: "resume", assignee: "lab" });
      const sent = yield* issues.start(issue.id, "");
      yield* w.nextReport;
      const first = (yield* sessions.get(sent.session!))!;
      expect(first.branch).toBe(`vibevalley/issue-${issue.number}`);
      const before = git(first.worktree!, "rev-parse", "HEAD");
      yield* sessions.dismiss(first.id);
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.closedAt !== undefined,
        "cancelled",
      );
      let again = yield* issues.reopen(issue.id, "接着做", "");
      yield* w.nextReport;
      const reopened = (yield* sessions.get(again))!;
      expect([reopened.branch, reopened.worktree]).toEqual([first.branch, first.worktree]);
      expect(git(reopened.worktree!, "rev-parse", "HEAD")).toBe(before);
      expect(reopened.brief).toContain("这条分支上已经有上次的提交，接着做。");
      yield* issues.merge(issue.id);
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.delivered === "merged",
        "merged",
      );
      again = yield* issues.reopen(issue.id, "再看看", "");
      yield* w.nextReport;
      expect((yield* sessions.get(again))!.brief).not.toContain("这条分支上已经有上次的提交，接着做。");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // An act is the server's: only what the attention offers, with the words the server puts to the helper, by number too.
  it.live("does an act as the issue's page does it", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      yield* (yield* Agents).saveAgent(lab());
      const drop = yield* issues.add({ title: "先放着", project: "acts", assignee: "lab" });
      refusedWith(yield* Effect.flip(issues.act(drop.id, { act: "cure" }, "")), "现在不能「接着修」");
      const dropped = yield* issues.act(drop.id, { act: "close" }, "");
      expect(dropped.status).toBe("canceled");
      // Never sent: a reopen is back to the backlog, with nothing to tell.
      expect((yield* issues.act("#" + drop.number, { act: "reopen" }, "")).status).toBe("backlog");

      const issue = yield* issues.add({ title: "这一单必败", project: "acts", assignee: "lab" });
      yield* issues.act(String(issue.number), { act: "start" }, "");
      yield* w.nextReport;
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.attention.stuck === "failed",
        "stuck: failed",
      );
      refusedWith(yield* Effect.flip(issues.act(issue.id, { act: "complete" }, "")), "现在不能「完成」");
      refusedWith(yield* Effect.flip(issues.act(issue.id, { act: "tell" }, "")), "「带话」要说一句");
      yield* issues.act("#" + issue.number, { act: "cure" }, "");
      const thread = (yield* chat.jobThread((yield* issues.get(issue.id)).sessions.at(-1)!))!;
      yield* until(
        () => messagesIn(core.state().chat, thread).some((m) => m.from === "user" && m.text === "接着修：这一单必败。看一下报错，修好再跑一遍测试"),
        "the cure said once, by the server",
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A dry run of a move says what it would do, from the same judgment as the move, and changes nothing: no git, no status.
  it.live("says what completing would deliver before it is done, and then does that", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      yield* (yield* Agents).saveAgent(lab());
      const project = join(f.config.workRoot, "projects", "clock");
      const committed = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const before = git(project, "log", "--format=%s", "main");
      const merging = yield* issues.previewStatus(committed.issue!, "done", "");
      expect(merging.does.at(-1)).toMatch(/^合进 main（1 个提交），关成已完成，/);
      const keeping = yield* issues.previewStatus(committed.issue!, "done", "", { keepBranch: true });
      expect(keeping.does[0]).toMatch(/关成已完成：分支留着没合（1 个提交）$/);
      expect([git(project, "log", "--format=%s", "main"), (yield* issues.get(committed.issue!)).status]).toEqual([before, "in_review"]);
      yield* issues.setStatus(committed.issue!, "done", "", "");
      const done = yield* await_(
        () => issues.get(committed.issue!),
        (i) => i.closedAt !== undefined,
        "done",
      );
      expect(done.delivered).toBe("merged");

      const looked = mustHire(yield* issues.hire(lab(), "看看打卡页", "clock"));
      yield* w.nextReport;
      expect((yield* issues.previewStatus(looked.issue!, "done", "")).does[0]).toMatch(/关成已完成：没有改动要合$/);
      expect((yield* issues.previewAct(looked.issue!, { act: "close" })).does[0]).toMatch(/关成已取消$/);
      refusedWith(yield* Effect.flip(issues.previewAct(looked.issue!, { act: "tell" })), "要说一句");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // An answer issue is read only: its conclusion is read into the issue, whatever the round changed goes, and completing it
  // delivers nothing. An answer that cannot be read is a round not done: 接着修 says what was wrong with it.
  it.live("answers with a conclusion and leaves nothing on its branch", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      yield* (yield* Agents).saveAgent(lab());
      const project = join(f.config.workRoot, "projects", "clock");
      const asked = yield* issues.add({ title: "查一下打卡为什么慢，顺手提交", project: "clock", assignee: "lab", deliver: "answer" });
      expect(asked.deliver).toBe("answer");
      yield* issues.setStatus(asked.id, "todo", "", "");
      yield* w.nextReport;
      const answered = yield* await_(
        () => issues.get(asked.id),
        (i) => i.answer !== undefined && i.attention.state === "reviewing",
        "its conclusion",
      );
      expect(answered.answer).toEqual({
        conclusion: "打卡慢是因为每次都重读配置",
        evidence: ["clock.ts:1 每次调用都读一遍配置"],
        unsure: [],
        next: ["把配置读一次缓存起来"],
      });
      expect(answered.attention.acts).toEqual(["acknowledge", "reject", "tell", "close"]);
      const branch = `vibevalley/issue-${answered.number}`;
      yield* until(() => git(project, "rev-parse", branch) === git(project, "rev-parse", "main"), "what it committed gone");
      yield* issues.act(asked.id, { act: "acknowledge" }, "");
      const done = yield* await_(
        () => issues.get(asked.id),
        (i) => i.closedAt !== undefined,
        "done",
      );
      expect([done.status, done.delivered, done.answer?.conclusion]).toEqual(["done", "none", "打卡慢是因为每次都重读配置"]);

      const garbled = yield* issues.add({ title: "查一下 乱写", project: "clock", assignee: "lab", deliver: "answer" });
      yield* issues.setStatus(garbled.id, "todo", "", "");
      yield* w.nextReport;
      const stuck = yield* await_(
        () => issues.get(garbled.id),
        (i) => i.attention.stuck === "failed",
        "stuck: no answer read",
      );
      expect([stuck.answer, stuck.moves]).toEqual([undefined, ["todo", "canceled"]]);
      refusedWith(yield* Effect.flip(issues.setStatus(garbled.id, "done", "", "")), "这一轮没做成");
      yield* issues.act(garbled.id, { act: "cure" }, "");
      const thread = (yield* chat.jobThread(stuck.sessions.at(-1)!))!;
      yield* until(
        () => messagesIn(core.state().chat, thread).some((m) => m.from === "user" && m.text.startsWith("接着修：上一轮交回的结论读不出来（没找到结论")),
        "what was wrong with it, said",
      );
      yield* w.nextReport;
      yield* await_(
        () => issues.get(garbled.id),
        (i) => i.answer !== undefined && i.attention.state === "reviewing",
        "answered the second time",
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // Done is what was asked for, not how a round ended: a round that failed is not completed, whoever asks.
  it.live("does not complete a round that failed", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      yield* (yield* Agents).saveAgent(lab());
      const issue = yield* issues.add({ title: "这一单必败", project: "fails", assignee: "lab" });
      yield* issues.setStatus(issue.id, "todo", "", "");
      yield* w.nextReport;
      const failed = yield* await_(
        () => issues.get(issue.id),
        (i) => i.attention.stuck === "failed",
        "stuck: failed",
      );
      expect(failed.status).toBe("in_review");
      expect(failed.moves).toEqual(["todo", "canceled"]);
      refusedWith(yield* Effect.flip(issues.setStatus(issue.id, "done", "", "")), "这一轮没做成");
      refusedWith(yield* Effect.flip(issues.merge(issue.id)), "这一轮没做成");
      expect((yield* issues.get(issue.id)).closedAt).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // Every issue has an acceptance: one that must pass waits for it; a fail grows weeds and another round; a pass is ready to complete.
  // A question in a report leaves the plot short of fertilizer until the owner answers.
  it.live("grows through its acceptance", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      let issue = yield* issues.add({ title: "先问清楚，再写打卡并提交", project: "clock", assignee: "lab", review: "required" });
      expect(issue.review).toBe("required");
      yield* issues.setStatus(issue.id, "todo", "", "");
      yield* w.nextReport;
      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => (i.questions ?? []).length === 1,
        "its question kept",
      );
      expect(issue.questions).toEqual([{ question: "用 8787 还是 8797？" }]);
      const crop = () => viewOf(core.state()).plots[issue.id]?.crop;
      yield* until(() => crop() === "dry", "the plot waiting on an answer");

      yield* issues.comment(issue.id, "用 8797");
      yield* await_(
        () => issues.get(issue.id),
        (i) => (i.questions ?? []).length === 0,
        "answered",
      );
      yield* w.nextReport;
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.status === "in_review",
        "handed back",
      );
      yield* until(() => crop() === "flowering", "抽穗：等验收");
      refusedWith(yield* Effect.flip(issues.setStatus(issue.id, "done", "", "")));

      yield* issues.review(issue.id, { pass: false, findings: ["再写版本B"] });
      expect(openFindings(yield* issues.get(issue.id))).toBe(1);
      yield* w.nextReport;
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.status === "in_review",
        "the weed worked on and handed back",
      );
      // Handed back again it waits on the owner's acceptance, as its page says; the findings stay open until a pass.
      yield* until(() => crop() === "flowering", "waiting on the acceptance again");
      expect(openFindings(yield* issues.get(issue.id))).toBe(1);

      issue = yield* issues.review(issue.id, { pass: true });
      expect([issue.reviewedAt !== undefined, openFindings(issue), (issue.moves ?? []).includes("done")]).toEqual([true, 0, true]);
      issue = yield* issues.setStatus(issue.id, "done", "", "");
      expect(issue.status).toBe("done");
      expect(git(join(f.config.workRoot, "projects", "clock"), "log", "--format=%s", "main")).toMatch(/版本 B/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("is not sent when the money runs out", () => {
    let usage: AccountUsage | null = null;
    const f = farm({ usage: () => usage });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const runtimes = yield* Runtimes;
      const agents = yield* Agents;
      const hire = () => Effect.map(issues.hire(lab(), "随便做点什么", "money"), (h) => h.refused ?? "");
      const settings = agents.settings("pi");

      usage = { status: "balance", provider: "DeepSeek", available: true, balances: [{ currency: "CNY", amount: 0 }] };
      yield* runtimes.refresh("pi");
      expect(yield* hire()).toMatch(/余额用完了/);

      usage = null;
      runtimes.spend("pi", 1.2);
      yield* runtimes.update("pi", { ...settings, dailyBudget: 1 });
      expect(yield* hire()).toMatch(/每日预算 ¥1\.00/);

      // A window used up would only fail with a quota error.
      const resets = new Date(2026, 9, 14, 8, 0).getTime();
      usage = {
        status: "ok",
        subscription: "pro",
        windows: [
          { label: "5h", usedPercent: 40, resetsAt: null },
          { label: "Codex · 1 week", usedPercent: 100, resetsAt: resets },
        ],
      };
      yield* runtimes.update("pi", settings);
      expect(yield* hire()).toMatch(/额度用完了（Codex · 1 week），10 月 14 日 08:00重置/);

      usage = { status: "ok", subscription: "pro", windows: [{ label: "Codex · 1 week", usedPercent: 99, resetsAt: resets }] };
      yield* runtimes.refresh("pi");
      expect(yield* hire()).toBe("");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
