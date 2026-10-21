import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { Issue } from "@vibevalley/protocol";
import { messagesIn } from "../channel/state.ts";
import { Effect } from "effect";
import { Agents } from "../agent/agent.ts";
import { Core } from "../core/core.ts";
import { Issues } from "../issue/issue.ts";
import { Sessions } from "../session/session.ts";
import { await_, farm, git, lab, mustHire, until, watch } from "./farm.ts";

const drafting = (core: Core["Service"]) => core.state().sessions.some((h) => h.draft);

const hasBranch = (project: string, branch: string) => {
  try {
    git(project, "show-ref", "--verify", "--quiet", "refs/heads/" + branch);
    return true;
  } catch {
    return false;
  }
};

/** Nothing a draft did stays: reset to main, its worktree is clean, so it goes with its drafter, and so does its branch,
 * which has nothing main does not. */
const draftLeftNothing = (work: string, issue: Issue) => {
  const project = join(work, "projects", issue.project!);
  const tree = join(work, "worktrees", `${issue.project}.${issue.number}`);
  return until(() => !existsSync(tree) && !hasBranch(project, `vibevalley/issue-${issue.number}`), "its worktree and branch are gone");
};

describe("a drafted issue", () => {
  // The plus makes an unsent issue; a session drafts it to the issue's format and leaves, the issue still in the
  // backlog. It asks; the owner's answer makes a second draft over the first; sent out, its session is told the criteria.
  it.live("is drafted before it is sent", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      // It names no one: whoever was last sent to work in the project drafts it.
      const before = mustHire(yield* issues.hire(lab(), "看看项目", "board"));
      yield* w.nextReport;
      yield* sessions.dismiss(before.id);
      let issue = yield* issues.add({ title: "新工单", project: "board" });
      const got = yield* issues.draft(issue.id, "慢慢看：看板拖卡还在调旧接口", "");
      expect([got.status, got.title, got.assignee, got.sessions?.length ?? 0]).toEqual(["backlog", "慢慢看：看板拖卡还在调旧接口", "lab", 0]);
      expect(got.drafting?.name).toBe(lab().name);
      expect(got.moves).toEqual(["canceled"]);
      expect((yield* Effect.flip(issues.setStatus(issue.id, "todo", "", "")))._tag).toBe("Refused");
      expect((yield* Effect.flip(issues.draft(issue.id, "再来", "")))._tag).toBe("Refused");

      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => i.title === "看板拖卡改用 issue.status" && i.drafting === undefined,
        "the draft written into the issue",
      );
      expect(issue.description).toBe("为什么：\n看板还在调旧接口\n\n要做的：\n- 改 board.dart\n\n可能涉及：\n- board.dart");
      expect(issue.criteria).toEqual(["拖到待办就开工"]);
      expect(issue.asks).toEqual([{ question: "用 8787 还是 8797？" }]);
      expect([issue.status, issue.sessions?.length ?? 0]).toEqual(["backlog", 0]);
      yield* until(() => !drafting(core), "the drafter left");
      yield* draftLeftNothing(f.config.workRoot, issue);
      const runs = yield* sessions.runs(issue.id);
      expect(runs.map((r) => r.triggeredBy.kind)).toEqual(["draft"]);
      const inState = () => core.state().issues!.find((x) => x.id === issue.id)!;
      yield* until(
        () => inState().drafting === undefined && (inState().moves ?? []).includes("todo") && inState().criteria?.length === 1,
        "the core state has its draft",
      );

      yield* issues.draft(issue.id, "用 8797", "");
      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => i.title === "看板拖卡改用 8797 端口" && i.drafting === undefined,
        "the second draft over the first",
      );
      expect([issue.criteria, issue.asks?.length ?? 0]).toEqual([["拖到待办就开工", "端口是 8797"], 0]);
      yield* until(() => !drafting(core), "the second drafter left");

      issue = yield* issues.setStatus(issue.id, "todo", "", "");
      expect(issue.sessions).toHaveLength(1);
      const brief = sessions.find(issue.sessions![0]!)!.session.brief;
      for (const want of ["看板拖卡改用 8797 端口", "验收标准", "1. 拖到待办就开工\n2. 端口是 8797"]) expect(brief).toContain(want);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A drafter that changes files and commits leaves the worktree as main has it; canceling an issue mid-draft sends the
  // drafter home and leaves no worktree or branch.
  it.live("leaves nothing behind", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      let issue = yield* issues.add({ title: "新工单", project: "board", assignee: "lab" });
      yield* issues.draft(issue.id, "顺手提交：看板拖卡", "");
      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => (i.criteria ?? []).length > 0 && i.drafting === undefined,
        "drafted",
      );
      yield* until(() => !drafting(core), "the drafter left");
      yield* draftLeftNothing(f.config.workRoot, issue);
      const project = join(f.config.workRoot, "projects", "board");
      expect(git(project, "log", "--format=%s", "--all")).not.toContain("起草时不该有的提交");

      const canceled = yield* issues.add({ title: "新工单", project: "board", assignee: "lab" });
      yield* issues.draft(canceled.id, "慢慢看：取消它", "");
      const tree = join(f.config.workRoot, "worktrees", `board.${canceled.number}`);
      expect(existsSync(tree)).toBe(true);
      const got = yield* issues.setStatus(canceled.id, "canceled", "", "");
      expect(got.status).toBe("canceled");
      yield* until(() => !drafting(core), "the drafter went home");
      yield* until(() => !existsSync(tree), "its worktree is gone");
      expect(hasBranch(project, `vibevalley/issue-${canceled.number}`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A draft that does not read leaves the issue as it was and says so in the issue's thread.
  it.live("that cannot be read changes nothing", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      const issue = yield* issues.add({ title: "新工单", project: "board", assignee: "lab" });
      // Slow enough for the thread to open before it hands back, as any real draft is.
      const before = yield* issues.draft(issue.id, "慢慢乱写一通", "");
      yield* until(() => !drafting(core), "the drafter left");
      const thread = () => core.state().chat?.conversations?.find((c) => c.subjectId === issue.id)?.id;
      yield* until(() => thread() !== undefined, "the issue's thread");
      yield* until(
        () => messagesIn(core.state().chat, thread()!).some((m) => m.kind === "notice" && m.text.includes("读不出来")),
        "the thread says the draft did not read",
      );
      const after = yield* issues.get(issue.id);
      expect([after.title, after.description, after.criteria, after.status]).toEqual([before.title, before.description, before.criteria, "backlog"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
