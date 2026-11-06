import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { assignedAgentOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { owner, session as sessionActor } from "#/base/actor.ts";
import { Issue } from "#/issue/issue.ts";
import { Session } from "#/session/session.ts";
import { gitIn } from "#/testing/git.ts";
import { testIssues } from "#/testing/world.ts";

import { farm, lab, mustHire, await_ } from "./farm.ts";

const steps = [
  { id: "a", brief: "test-step-a", agent: "lab", check: "test -f a.txt" },
  { id: "b", brief: "test-step-b", agent: "lab", check: "test -f b.txt" },
  { id: "c", brief: "test-step-c", agent: "lab", needs: ["a", "b"] },
];

it.live("regression: splitting an in-place session cannot create children with an unrelated parent branch", () => {
  const f = farm({ repos: ["in-place"], runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("finished") }) });
  return Effect.gen(function* () {
    const service = yield* Issue;
    const issues = testIssues(service);
    yield* (yield* Agent).save(lab());
    const parent = yield* issues.add({ title: "parent", repo: "in-place", agent: "lab" });
    const helper = mustHire(yield* issues.hire(lab(), "work in place", "in-place", { issue: parent.id, worktree: false }));
    expect(helper.branch).toBeUndefined();
    expect((yield* Effect.flip(service.split(parent.id, "", steps, sessionActor(helper.id))))._tag).toBe("Refused");
    expect((yield* issues.list()).filter((issue) => issue.parent === parent.id)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: splitting preserves the parent's assignment and branch ancestry", () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const f = farm({
    repos: ["board"],
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        if (turn.options.cwd.endsWith("board.1")) {
          await gate;
          turn.say("结论：拆成了三步");
        } else {
          const id = turn.options.cwd.endsWith("board.2") ? "a" : turn.options.cwd.endsWith("board.3") ? "b" : "c";
          writeFileSync(join(turn.options.cwd, `${id}.txt`), id);
          gitIn(turn.options.cwd, "add", ".");
          gitIn(turn.options.cwd, "commit", "-m", "Implement child issue");
          turn.say("finished");
        }
      },
    }),
  });
  return Effect.gen(function* () {
    const issues = testIssues(yield* Issue);
    const sessions = yield* Session;
    yield* (yield* Agent).save(lab());
    const issue = yield* issues.add({ title: "整个看板重做", description: "像 Linear 那样", repo: "board", agent: "lab" });
    yield* issues.edit(issue.id, { criteria: ["卡片紧凑"] }, owner);
    const helper = mustHire(yield* issues.hire(lab(), "hold-parent", "board", { issue: issue.id, worktree: true }));
    const service = yield* Issue;
    expect(yield* service.split(issue.id, "", steps, sessionActor(helper.id))).toMatch(/3 张子工单/u);
    const children = (yield* issues.list()).filter((item) => item.parent === issue.id);
    expect(children).toHaveLength(3);
    const parent = yield* issues.get(issue.id);
    expect([parent.number, assignedAgentOf(parent), parent.criteria, sessionIdsOf(parent)[0]]).toEqual([issue.number, "lab", ["卡片紧凑"], helper.id]);
    expect((yield* Effect.exit(service.split(issue.id, "", steps, sessionActor(helper.id))))._tag).toBe("Failure");
    release();

    yield* await_(
      () => Effect.andThen(issues.refreshQueue, issues.get(issue.id)),
      (item) => item.status === "in_review",
      "all native children merged",
    );
    expect(sessions.present(helper.id)).toBe(true);
    expect((yield* issues.get(issue.id)).closedAt).toBeUndefined();
    expect(gitIn(helper.worktree!, "status", "--porcelain")).toBe("");
  }).pipe(Effect.ensuring(Effect.sync(release)), Effect.scoped, Effect.provide(f.layer));
});
