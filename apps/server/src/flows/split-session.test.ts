import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { BizCode } from "@vibevalley/protocol/api";
import { assignedAgentOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { user, worker as sessionActor } from "#/base/actor.ts";
import { gitIn } from "#/testing/git.ts";
import { testIssues } from "#/testing/world.ts";

import { farm, lab, mustHire, await_, failure } from "./farm.ts";

const steps = [
  { id: "a", brief: "test-step-a", agent: "lab", check: "test -f a.txt" },
  { id: "b", brief: "test-step-b", agent: "lab", check: "test -f b.txt" },
  { id: "c", brief: "test-step-c", agent: "lab", needs: ["a", "b"] },
];

test("regression: splitting an in-place session cannot create children with an unrelated parent branch", async () => {
  const f = farm({ repos: ["in-place"], runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("finished") }) });
  await using fw = await f.open();
  const service = fw.issue;
  const issues = testIssues(service);
  await fw.agent.save(lab());
  const parent = await issues.add({ title: "parent", repo: "in-place", agent: "lab" });
  const hired = await issues.hire(lab(), "work in place", "in-place", { issue: parent.id, worktree: false });
  const helper = mustHire(hired);
  expect(helper.branch).toBeUndefined();
  expect((await failure(service.split(parent.id, "", steps, sessionActor(helper.id)))).bizCode).toBe(BizCode.IssueRefused);
  expect((await issues.list()).filter((issue) => issue.parent === parent.id)).toEqual([]);
});

test("regression: splitting preserves the parent's assignment and branch ancestry", async () => {
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
  await using fw = await f.open();
  try {
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.session;
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "整个看板重做", description: "像 Linear 那样", repo: "board", agent: "lab" });
    await issues.edit(issue.id, { criteria: ["卡片紧凑"] }, user);
    const hired = await issues.hire(lab(), "hold-parent", "board", { issue: issue.id, worktree: true });
    const helper = mustHire(hired);
    const service = fw.issue;
    const split2 = await service.split(issue.id, "", steps, sessionActor(helper.id));
    expect(split2).toMatch(/3 张子工单/u);
    const children = (await issues.list()).filter((item) => item.parent === issue.id);
    expect(children).toHaveLength(3);
    const parent = await issues.get(issue.id);
    expect([parent.number, assignedAgentOf(parent), parent.criteria, sessionIdsOf(parent)[0]]).toEqual([issue.number, "lab", ["卡片紧凑"], helper.id]);
    expect(await failure(service.split(issue.id, "", steps, sessionActor(helper.id)))).toBeInstanceOf(Error);
    release();

    await await_(
      async () => {
        await issues.refreshQueue();
        return issues.get(issue.id);
      },
      (item) => item.status === "in_review",
      "all native children merged",
    );
    expect(sessions.isReachable(helper.id)).toBe(true);
    expect((await issues.get(issue.id)).closedAt).toBeUndefined();
    expect(gitIn(helper.worktree!, "status", "--porcelain")).toBe("");
  } finally {
    release();
  }
});
