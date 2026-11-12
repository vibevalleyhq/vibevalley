import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { issueBranch } from "#/modules/repo/repo.ts";
import { gitSync } from "#/testing/git.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab } from "./farm.ts";

test("regression: native child issues wait for prerequisites and start from their parent's branch", async () => {
  const release = Promise.withResolvers<void>();
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        await release.promise;
        turn.say("收到");
      },
    }),
  });
  await using fw = await f.open();
  try {
    const service = fw.issue;
    const issues = testIssues(service);
    const sessions = fw.inside;
    await fw.agent.save(lab());
    const parent = await issues.add({ title: "父工单", agent: "lab", repo: "native" });
    const parentPlace = await fw.repo.checkout({ repo: "native", issue: parent.number, worktree: true, base: "" });
    gitSync(parentPlace.cwd, "commit", "--allow-empty", "-m", "Prepare parent work");
    const parentHead = gitSync(parentPlace.cwd, "rev-parse", "HEAD");
    const prerequisite = await issues.add({ title: "前置工单", agent: "lab", repo: "native" });
    const child = await issues.add({ title: "子工单", parent: parent.id, blockedBy: [prerequisite.id] });
    expect([child.repo, assignedAgentOf(child)]).toEqual([parent.repo, "lab"]);
    expect(child.stage.acts.map((act) => act.act)).toContain("start");
    expect((await issues.start(child.id, "")).queued).toBeDefined();
    await fw.issue.refreshQueue();
    expect(sessions.hired()).toEqual([]);
    await service.setStatus(prerequisite.id, "canceled", "", "", user);
    await fw.issue.refreshQueue();
    const started = await await_(
      () => issues.get(child.id),
      (item) => latestSessionIdOf(item) !== undefined,
      "the unblocked child",
    );
    const session = sessions.sessionOf(latestSessionIdOf(started)!)!;
    expect(session.branch).toBe(issueBranch(child.number));
    expect(gitSync(session.worktree!, "merge-base", parentHead, "HEAD")).toBe(parentHead);
    expect((await issues.get(child.id)).blockedBy).toEqual([prerequisite.id]);
  } finally {
    release.resolve();
  }
});
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("regression: child changes merge into the parent worktree and reach main only after parent acceptance", async () => {
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        writeFileSync(join(turn.options.cwd, "child.txt"), "child result");
        gitSync(turn.options.cwd, "add", "child.txt");
        gitSync(turn.options.cwd, "commit", "-m", "Implement child work");
        turn.say("完成");
      },
    }),
  });
  await using fw = await f.open();
  const service = fw.issue;
  const issues = testIssues(service);
  const repos = fw.repo;
  await fw.agent.save(lab());
  const parent = await issues.add({ title: "父工单", agent: "lab", repo: "merge-family" });
  const child = await issues.add({ title: "子工单", parent: parent.id });
  await issues.start(parent.id, "");
  const completed = await await_(
    () => issues.get(child.id),
    (item) => item.status === "done",
    "the child merged into its parent",
  );
  expect(completed.delivered).toBe("merged_into_parent");
  expect((await issues.get(parent.id)).status).toBe("in_review");
  const place = await repos.checkout({ repo: "merge-family", issue: parent.number, worktree: true, base: "" });
  expect(readFileSync(join(place.cwd, "child.txt"), "utf8")).toBe("child result");
  expect(gitSync(place.cwd, "status", "--porcelain")).toBe("");
  const main = join(f.config.workRoot, "repos", "merge-family");
  expect(existsSync(join(main, "child.txt"))).toBe(false);
  await service.setStatus(parent.id, "done", "", "", user);
  expect(readFileSync(join(main, "child.txt"), "utf8")).toBe("child result");
  expect((await issues.get(parent.id)).delivered).toBe("merged");
});

test("regression: automatic child merge preserves uncommitted parent work", async () => {
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        writeFileSync(join(turn.options.cwd, "child.txt"), "child result");
        gitSync(turn.options.cwd, "add", "child.txt");
        gitSync(turn.options.cwd, "commit", "-m", "Implement child work");
        turn.say("完成");
      },
    }),
  });
  await using fw = await f.open();
  const issue = fw.issue;
  const issues = testIssues(issue);
  await fw.agent.save(lab());
  const parent = await issues.add({ title: "父工单", agent: "lab", repo: "dirty-parent" });
  const place = await fw.repo.checkout({ repo: "dirty-parent", issue: parent.number, worktree: true, base: "" });
  writeFileSync(join(place.cwd, "user.txt"), "unfinished user work");
  const before = gitSync(place.cwd, "rev-parse", "HEAD");
  const child = await issues.add({ title: "子工单", parent: parent.id });
  await issues.start(child.id, "");
  await await_(
    () => issues.get(child.id),
    (item) => item.questions.length > 0,
    "the blocked merge explained",
  );
  expect((await issues.get(child.id)).delivered).toBeUndefined();
  expect(gitSync(place.cwd, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(place.cwd, "user.txt"), "utf8")).toBe("unfinished user work");
  expect(existsSync(join(place.cwd, "child.txt"))).toBe(false);
});
