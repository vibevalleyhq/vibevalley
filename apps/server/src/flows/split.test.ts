import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { BizCode } from "@vibevalley/protocol/api";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { inbox } from "#/modules/inbox/items.ts";
import { gitSync } from "#/testing/git.ts";
import { refuse } from "#/testing/refuse.ts";
import { sqlOf } from "#/testing/sql.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab, failure } from "./farm.ts";

test("regression: a parent without a session can receive and resolve its own branch conflict", async () => {
  let turns = 0;
  const f = farm({
    repos: ["parent-conflict"],
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const fixing = turns++ > 0;
        if (fixing) expect(turn.input).toContain("same.ts");
        writeFileSync(join(turn.options.cwd, "same.ts"), fixing ? "main\n" : "child\n");
        gitSync(turn.options.cwd, "add", ".");
        gitSync(turn.options.cwd, "commit", "-m", fixing ? "Resolve conflict" : "Implement child");
        turn.say("done");
      },
    }),
  });
  await using fw = await f.open();
  const issues = fw.issue;
  await fw.agent.save(lab());
  const root = join(f.config.workRoot, "repos", "parent-conflict");
  writeFileSync(join(root, "same.ts"), "base\n");
  gitSync(root, "add", ".");
  gitSync(root, "commit", "-m", "Prepare conflict file");
  const parent = await testIssues(issues).add({ title: "parent", repo: "parent-conflict", agent: "lab" });
  await issues.split(parent.id, "", [{ id: "child", title: "child", brief: "child work" }], user);
  await await_(
    () => issues.get(parent.id),
    (item) => item.status === "in_review",
    "the child merged into its parent",
  );
  writeFileSync(join(root, "same.ts"), "main\n");
  gitSync(root, "add", ".");
  gitSync(root, "commit", "-m", "Change main");
  await issues.changes(parent.id, user);
  const conflicted = await issues.get(parent.id);
  expect(conflicted.conflict).toEqual({ base: "main", files: ["same.ts"] });
  expect(conflicted.stage).toMatchObject({ state: "stuck", stuck: "conflict" });
  expect(inbox(fw.core.state()).some((item) => item.kind === "conflict" && item.target.kind === "issue" && item.target.id === parent.id)).toBe(true);
  await issues.setStatus(parent.id, "todo", "", "", user);
  const resolved = await await_(
    () => issues.get(parent.id),
    (item) => item.status === "in_review" && item.conflict === undefined,
    "the parent conflict resolved",
  );
  expect(latestSessionIdOf(resolved)).toBeDefined();
  expect((await issues.setStatus(parent.id, "done", "", "", user)).status).toBe("done");
});

test("regression: splitting creates real queued issues whose dependencies merge into the parent", async () => {
  const first = Promise.withResolvers<void>();
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const next = existsSync(join(turn.options.cwd, "first.txt"));
        if (!next) await first.promise;
        writeFileSync(join(turn.options.cwd, next ? "second.txt" : "first.txt"), "done");
        gitSync(turn.options.cwd, "add", ".");
        gitSync(turn.options.cwd, "commit", "-m", "Implement child issue");
        turn.say("finished");
      },
    }),
  });
  await using fw = await f.open();
  const service = fw.issue;
  const issues = testIssues(service);
  await fw.agent.save(lab());
  const parent = await issues.add({ title: "parent", agent: "lab", repo: "split" });
  await service.split(
    parent.id,
    "split parent",
    [
      { id: "first", title: "first", brief: "first work" },
      { id: "second", title: "second", brief: "second work", needs: ["first"] },
    ],
    user,
  );
  const children = (await issues.list()).filter((item) => item.parent === parent.id);
  const a = children.find((item) => item.title === "first")!;
  const b = children.find((item) => item.title === "second")!;
  expect(children).toHaveLength(2);
  expect(b.blockedBy).toEqual([a.id]);
  expect(b.status).toBe("todo");
  expect(a.stage.acts.length).toBeGreaterThan(0);
  first.resolve();
  await await_(
    () => issues.get(a.id),
    (item) => item.status === "done",
    "the first child merged",
  );
  await fw.issue.refreshQueue();
  await await_(
    () => issues.get(b.id),
    (item) => item.status === "done",
    "the dependent child merged",
  );
  expect((await issues.get(parent.id)).status).toBe("in_review");
  const waiting = inbox(fw.core.state()).filter((item) => item.kind === "review");
  expect(waiting).toHaveLength(1);
  expect(waiting[0]?.target).toEqual({ kind: "issue", id: parent.id });
  expect((await service.changes(parent.id, user)).commits.length).toBeGreaterThan(0);
  const place = await fw.repo.checkout({ repo: "split", issue: parent.number, worktree: true, base: "" });
  expect(readFileSync(join(place.cwd, "second.txt"), "utf8")).toBe("done");
  await service.setStatus(parent.id, "done", "", "", user);
  const core = fw.core;
  await await_(
    () => core.state().progress,
    (progress) => progress?.counts.big_graph === 2,
    "the completed family reward",
  );
  expect(core.state().progress?.counts.s_split).toBe(1);
});

test("regression: a failed split commits no child, assignment, queue entry or parent rename", async () => {
  const f = farm();
  await using fw = await f.open();
  const service = fw.issue;
  const issues = testIssues(service);
  const sql = sqlOf(fw.db);
  await fw.agent.save(lab());
  const parent = await issues.add({ title: "parent", agent: "lab", repo: "split-failure" });
  await refuse(fw.db, "reject_child", "before insert on issue", "NEW.title = 'second'", "child write failed");
  const result = await failure(
    service.split(
      parent.id,
      "renamed",
      [
        { id: "first", title: "first", brief: "work" },
        { id: "second", title: "second", brief: "work", needs: ["first"] },
      ],
      user,
    ),
  );
  expect(result.bizCode).toBe(BizCode.IssueRefused);
  expect((await issues.list()).map((item) => [item.id, item.title])).toEqual([[parent.id, "parent"]]);
  expect(fw.core.state().issues.map((item) => item.id)).toEqual([parent.id]);
  expect(fw.inside.hired()).toEqual([]);
  const unsafe2 = await sql.unsafe("select * from session_trigger where trigger_json::jsonb -> 'meta' -> 'dispatch' = 'true'::jsonb");
  expect(unsafe2).toHaveLength(0);
  const unsafe3 = await sql.unsafe("select * from session_issue_input");
  expect(unsafe3).toHaveLength(0);
  const unsafe4 = await sql.unsafe("select * from issue_assignment");
  expect(unsafe4).toHaveLength(1);
});
