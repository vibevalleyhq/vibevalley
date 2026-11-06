import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { owner } from "#/base/actor.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Issue } from "#/issue/issue.ts";
import { Session } from "#/session/session.ts";
import { releaseHeld } from "#/testing/worker.ts";
import { Said, testIssues } from "#/testing/world.ts";

import { await_, farm, git, lab, mustHire, until, watch } from "./farm.ts";

const drafting = (core: Core["Service"]) => core.state().sessions.some((h) => h.refining);

const hasBranch = (repo: string, branch: string) => {
  try {
    git(repo, "show-ref", "--verify", "--quiet", "refs/heads/" + branch);
    return true;
  } catch {
    return false;
  }
};

/** Nothing a draft did stays: reset to main, its worktree is clean, so it goes with its refiner, and so does its branch,
 * which has nothing main does not. */
const refinementLeftNothing = (work: string, issue: T.Issue) => {
  const repo = join(work, "repos", issue.repo!);
  const tree = join(work, "worktrees", `${issue.repo}.${issue.number}`);
  return until(() => !existsSync(tree) && !hasBranch(repo, `vibevalley/issue-${issue.number}`), "its worktree and branch are gone");
};

describe("a refined issue", () => {
  it.live("regression: repository-free drafts preserve discussion without dispatching work", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const chat = yield* Channel;
      const sessions = yield* Session;
      yield* (yield* Agent).save({ ...lab(), workdir: "" });
      const issue = yield* issues.add({ title: "讨论看板", agent: "lab" });
      yield* issues.comment(issue.id, "只讨论桌面端，不做移动端");
      yield* issues.refine(issue.id, "看板拖卡", "");
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.criteria.length > 0 && !i.refining,
        "first draft",
      );
      yield* issues.refine(issue.id, "用 8797", "");
      const drafted = yield* await_(
        () => issues.get(issue.id),
        (i) => i.title.includes("8797") && !i.refining,
        "second draft",
      );
      expect(drafted.repo).toBeUndefined();
      expect(drafted.status).toBe("backlog");
      expect(sessionIdsOf(drafted)).toEqual([]);
      expect(existsSync(join(f.config.workRoot, "repos", "board"))).toBe(false);
      const thread = yield* chat.issueThread(issue.id, issue.title);
      const messages = yield* chat.history(thread);
      expect(messages.filter((m) => m.fromKind === "owner").map((m) => m.text)).toEqual(["只讨论桌面端，不做移动端", "看板拖卡", "用 8797"]);
      expect(messages.some((m) => m.text.includes("看板拖卡改用 8797"))).toBe(true);
      const runs = yield* sessions.issueRuns(issue.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.triggeredBy.kind === "refine")).toBe(true);
      const latest = runs.at(-1);
      expect(latest).toBeDefined();
      if (latest) expect((yield* sessions.get(latest.session))?.brief).toContain("只讨论桌面端，不做移动端");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
  // The plus makes an unsent issue. a session drafts it to the issue's format and leaves, the issue still in the backlog.
  it.live("is refined before it is sent", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const core = yield* Core;
      yield* (yield* Agent).save(lab());
      // It names no one: whoever was last sent to work in the repo drafts it.
      const before = mustHire(yield* issues.hire(lab(), "看看仓库", "board"));
      yield* w.nextReport;
      yield* sessions.dismiss(before.id);
      let issue = yield* issues.add({ title: "新工单", repo: "board" });
      const got = yield* issues.refine(issue.id, "慢慢看：看板拖卡还在调旧接口", "");
      expect([got.status, got.title, assignedAgentOf(got), sessionIdsOf(got).length]).toEqual(["backlog", "慢慢看：看板拖卡还在调旧接口", "lab", 0]);
      expect(got.refining?.name).toBe(lab().name);
      expect(got.moves).toEqual(["canceled"]);
      expect((yield* Effect.flip(issues.setStatus(issue.id, "todo", "", "", owner)))._tag).toBe("Refused");
      expect((yield* Effect.flip(issues.refine(issue.id, "再来", "")))._tag).toBe("Refused");
      yield* releaseHeld();

      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => i.title === "看板拖卡改用 issue.status" && i.refining === undefined,
        "the draft written into the issue",
      );
      expect(issue.description).toBe("为什么：\n看板还在调旧接口\n\n要做的：\n- 改 board.dart\n\n可能涉及：\n- board.dart");
      expect(issue.criteria).toEqual(["拖到待办就开工"]);
      expect(issue.questions).toEqual([{ question: "用 8787 还是 8797？", options: [] }]);
      expect([issue.status, sessionIdsOf(issue).length]).toEqual(["backlog", 0]);
      yield* until(() => !drafting(core), "the refiner left");
      yield* refinementLeftNothing(f.config.workRoot, issue);
      const runs = yield* sessions.issueRuns(issue.id);
      expect(runs.map((r) => r.triggeredBy.kind)).toEqual(["refine"]);
      const inState = () => core.state().issues.find((x) => x.id === issue.id)!;
      yield* until(
        () => inState().refining === undefined && inState().moves.includes("todo") && inState().criteria.length === 1,
        "the core state has its draft",
      );

      yield* issues.refine(issue.id, "用 8797", "");
      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => i.title === "看板拖卡改用 8797 端口" && i.refining === undefined,
        "the second draft over the first",
      );
      expect([issue.criteria, issue.questions.length]).toEqual([["拖到待办就开工", "端口是 8797"], 0]);
      yield* until(() => !drafting(core), "the second refiner left");

      issue = yield* issues.setStatus(issue.id, "todo", "", "", owner);
      expect(sessionIdsOf(issue)).toHaveLength(1);
      const session = sessionIdsOf(issue)[0];
      if (session === undefined) throw new Error("the issue has no execution session");
      expect((yield* Effect.flip(issues.edit(issue.id, { description: "replace the confirmed goal" }, owner)))._tag).toBe("Refused");
      const brief = sessions.sessionOf(session)!.brief;
      for (const want of ["看板拖卡改用 8797 端口", "验收标准", "1. 拖到待办就开工\n2. 端口是 8797"]) expect(brief).toContain(want);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A refiner that changes files and commits leaves the worktree as main has it.
  it.live("leaves nothing behind", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      yield* (yield* Agent).save(lab());
      let issue = yield* issues.add({ title: "新工单", repo: "board", agent: "lab" });
      yield* issues.refine(issue.id, "顺手提交：看板拖卡", "");
      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => i.criteria.length > 0 && i.refining === undefined,
        "refined",
      );
      yield* until(() => !drafting(core), "the refiner left");
      yield* refinementLeftNothing(f.config.workRoot, issue);
      const repo = join(f.config.workRoot, "repos", "board");
      expect(git(repo, "log", "--format=%s", "--all")).not.toContain("起草时不该有的提交");

      const canceled = yield* issues.add({ title: "新工单", repo: "board", agent: "lab" });
      yield* issues.refine(canceled.id, "慢慢看：取消它", "");
      const tree = join(f.config.workRoot, "worktrees", `board.${canceled.number}`);
      expect(existsSync(tree)).toBe(true);
      const got = yield* issues.setStatus(canceled.id, "canceled", "", "", owner);
      expect(got.status).toBe("canceled");
      yield* until(() => !drafting(core), "the refiner went home");
      yield* until(() => !existsSync(tree), "its worktree is gone");
      expect(hasBranch(repo, `vibevalley/issue-${canceled.number}`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A draft that does not read leaves the issue as it was and says so in the issue's thread.
  it.live("that cannot be read changes nothing", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      const { in: saidIn } = yield* Said;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "新工单", repo: "board", agent: "lab" });
      // Held until the issue's thread is open, as it is before any real draft hands back.
      const before = yield* issues.refine(issue.id, "慢慢乱写一通", "");
      const thread = () => core.state().chat?.channels.find((c) => c.subjectId === issue.id)?.id;
      yield* until(() => thread() !== undefined, "the issue's thread");
      yield* releaseHeld();
      yield* until(() => !drafting(core), "the refiner left");
      yield* until(() => saidIn(thread()!).some((m) => m.kind === "notice" && m.text.includes("读不出来")), "the thread says the draft did not read");
      const after = yield* issues.get(issue.id);
      expect([after.title, after.description, after.criteria, after.status]).toEqual([before.title, before.description, before.criteria, "backlog"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
