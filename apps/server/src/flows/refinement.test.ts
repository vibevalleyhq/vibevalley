import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { assignedAgentOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { type Core } from "#/core/core.ts";
import { releaseHeld } from "#/testing/worker.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, git, lab, mustHire, until, watch, failure } from "./farm.ts";

const drafting = (core: Core) => core.state().sessions.some((h) => h.refining);

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
  test("regression: repository-free drafts preserve discussion without dispatching work", async () => {
    const f = farm();
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const chat = fw.channel;
    const sessions = fw.inside;
    await fw.agent.save({ ...lab(), workdir: "" });
    const issue = await issues.add({ title: "讨论看板", agent: "lab" });
    await issues.comment(issue.id, "只讨论桌面端，不做移动端");
    await issues.refine(issue.id, "看板拖卡", "");
    await await_(
      () => issues.get(issue.id),
      (i) => i.criteria.length > 0 && !i.refining,
      "first draft",
    );
    await issues.refine(issue.id, "用 8797", "");
    const drafted = await await_(
      () => issues.get(issue.id),
      (i) => i.title.includes("8797") && !i.refining,
      "second draft",
    );
    expect(drafted.repo).toBeUndefined();
    expect(drafted.status).toBe("backlog");
    expect(sessionIdsOf(drafted)).toEqual([]);
    expect(existsSync(join(f.config.workRoot, "repos", "board"))).toBe(false);
    const thread = await chat.issueThread(issue.id, issue.title);
    const messages = await chat.history(thread);
    expect(messages.filter((m) => m.actor.kind === "user").map((m) => m.text)).toEqual(["只讨论桌面端，不做移动端", "看板拖卡", "用 8797"]);
    expect(messages.some((m) => m.text.includes("看板拖卡改用 8797"))).toBe(true);
    const runs = await fw.intake.runsOf(issue.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.triggeredBy.kind === "refine")).toBe(true);
    const latest = runs.at(-1);
    expect(latest).toBeDefined();
    if (latest) expect((await sessions.get(latest.session))?.brief).toContain("只讨论桌面端，不做移动端");
  });
  // The plus makes an unsent issue. a session drafts it to the issue's format and leaves, the issue still in the backlog.
  test("is refined before it is sent", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    const core = fw.core;
    await fw.agent.save(lab());
    const hired = await issues.hire(lab(), "看看仓库", "board");
    const before = mustHire(hired);
    await w.nextReport();
    await sessions.dismiss(before.id);
    let issue = await issues.add({ title: "新工单", repo: "board" });
    const got = await issues.refine(issue.id, "慢慢看：看板拖卡还在调旧接口", "");
    expect([got.status, got.title, assignedAgentOf(got), sessionIdsOf(got).length]).toEqual(["backlog", "慢慢看：看板拖卡还在调旧接口", "lab", 0]);
    expect(got.refining?.name).toBe(lab().name);
    expect(got.moves).toEqual(["canceled"]);
    expect((await failure(issues.setStatus(issue.id, "todo", "", "", user))).bizCode).toBe(BizCode.IssueRefused);
    expect((await failure(issues.refine(issue.id, "再来", ""))).bizCode).toBe(BizCode.IssueRefused);
    await releaseHeld();

    issue = await await_(
      () => issues.get(issue.id),
      (i) => i.title === "看板拖卡改用 issue.status" && i.refining === undefined,
      "the draft written into the issue",
    );
    expect(issue.description).toBe("为什么：\n看板还在调旧接口\n\n要做的：\n- 改 board.dart\n\n可能涉及：\n- board.dart");
    expect(issue.criteria).toEqual(["拖到待办就开工"]);
    expect(issue.questions).toEqual([{ question: "用 8787 还是 8797？", options: [] }]);
    expect([issue.status, sessionIdsOf(issue).length]).toEqual(["backlog", 0]);
    await until(() => !drafting(core), "the refiner left");
    await refinementLeftNothing(f.config.workRoot, issue);
    const runs = await fw.intake.runsOf(issue.id);
    expect(runs.map((r) => r.triggeredBy.kind)).toEqual(["refine"]);
    const inState = () => core.state().issues.find((x) => x.id === issue.id)!;
    await until(() => inState().refining === undefined && inState().moves.includes("todo") && inState().criteria.length === 1, "the core state has its draft");

    await issues.refine(issue.id, "用 8797", "");
    issue = await await_(
      () => issues.get(issue.id),
      (i) => i.title === "看板拖卡改用 8797 端口" && i.refining === undefined,
      "the second draft over the first",
    );
    expect([issue.criteria, issue.questions.length]).toEqual([["拖到待办就开工", "端口是 8797"], 0]);
    await until(() => !drafting(core), "the second refiner left");

    issue = await issues.setStatus(issue.id, "todo", "", "", user);
    expect(sessionIdsOf(issue)).toHaveLength(1);
    const session = sessionIdsOf(issue)[0];
    if (session === undefined) throw new Error("the issue has no execution session");
    expect((await failure(issues.edit(issue.id, { description: "replace the confirmed goal" }, user))).bizCode).toBe(BizCode.IssueRefused);
    const brief = sessions.sessionOf(session)!.brief;
    for (const want of ["看板拖卡改用 8797 端口", "验收标准", "1. 拖到待办就开工\n2. 端口是 8797"]) expect(brief).toContain(want);
  });

  // A refiner that changes files and commits leaves the worktree as main has it.
  test("leaves nothing behind", async () => {
    const f = farm();
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const core = fw.core;
    await fw.agent.save(lab());
    let issue = await issues.add({ title: "新工单", repo: "board", agent: "lab" });
    await issues.refine(issue.id, "顺手提交：看板拖卡", "");
    issue = await await_(
      () => issues.get(issue.id),
      (i) => i.criteria.length > 0 && i.refining === undefined,
      "refined",
    );
    await until(() => !drafting(core), "the refiner left");
    await refinementLeftNothing(f.config.workRoot, issue);
    const repo = join(f.config.workRoot, "repos", "board");
    expect(git(repo, "log", "--format=%s", "--all")).not.toContain("起草时不该有的提交");

    const canceled = await issues.add({ title: "新工单", repo: "board", agent: "lab" });
    await issues.refine(canceled.id, "慢慢看：取消它", "");
    const tree = join(f.config.workRoot, "worktrees", `board.${canceled.number}`);
    expect(existsSync(tree)).toBe(true);
    const got = await issues.setStatus(canceled.id, "canceled", "", "", user);
    expect(got.status).toBe("canceled");
    await until(() => !drafting(core), "the refiner went home");
    await until(() => !existsSync(tree), "its worktree is gone");
    expect(hasBranch(repo, `vibevalley/issue-${canceled.number}`)).toBe(false);
  });

  // A draft that does not read leaves the issue as it was and says so in the issue's thread.
  test("that cannot be read changes nothing", async () => {
    const f = farm();
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const core = fw.core;
    const { in: saidIn } = fw.said;
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "新工单", repo: "board", agent: "lab" });
    // Held until the issue's thread is open, as it is before any real draft hands back.
    const before = await issues.refine(issue.id, "慢慢乱写一通", "");
    const thread = () => core.state().chat?.channels.find((c) => c.subjectId === issue.id)?.id;
    await until(() => thread() !== undefined, "the issue's thread");
    await releaseHeld();
    await until(() => !drafting(core), "the refiner left");
    await until(() => saidIn(thread()!).some((m) => m.kind === "notice" && m.text.includes("读不出来")), "the thread says the draft did not read");
    const after = await issues.get(issue.id);
    expect([after.title, after.description, after.criteria, after.status]).toEqual([before.title, before.description, before.criteria, "backlog"]);
  });
});
