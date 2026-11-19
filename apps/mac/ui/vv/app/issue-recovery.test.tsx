import "../polyfill";
import { expect, open, test } from "nsh/test";

import type { Issue } from "@vibevalley/protocol";

import { withIssues } from "../fixtures/issues";
import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

const fixture = withIssues({ state, responses });

async function detail(change: Partial<Issue>) {
  const space = fixture.state.state;
  const fake = fakeHost(
    {
      state: { ...fixture.state, state: { ...space, issues: space.issues.map((issue) => (issue.id === "i31" ? { ...issue, ...change } : issue)) } },
      responses: { ...fixture.responses, "host.openFile": null },
    },
    { route: "/issues/i31" },
  );
  const app = await open("./main.tsx", { width: 900, height: 720, host: fake.options });
  await fake.pump(app);
  return { app, fake };
}

test("regression: failed project checks reopen with the command and output visible", async () => {
  const { app } = await detail({
    deliveryEvidence: {
      reviews: [],
      check: {
        targetBranch: "main",
        targetCommit: "base",
        sourceTree: "source",
        candidateCommit: "0123456789abcdef",
        candidateTree: "tree",
        status: "failed",
        command: ".vibevalley/check",
        output: "regression-217: expected green, got red",
      },
    },
  });
  expect(app.count("id:failed-check-output")).toBe(1);
  expect(app.texts()).toContain(".vibevalley/check");
  expect(app.texts()).toContain("核对修复后，再次完成工单以重跑检查");
  expect(app.texts()).not.toContain("验收过了，可以完成");
  expect(app.texts()).toContain("regression-217: expected green, got red");
  await app.press("id:failed-project-check");
  expect(app.count("id:failed-check-output")).toBe(0);
  await app.press("id:failed-project-check");
  expect(app.count("id:failed-check-output")).toBe(1);
});

test("regression: a conflict file opens in its issue worktree", async () => {
  const { app, fake } = await detail({
    conflict: { base: "main", files: ["src/same.ts"] },
    stage: { state: "stuck", since: 1, stuck: "conflict", lead: "resolve", acts: [{ act: "resolve", does: "move", status: "todo", words: "none" }] },
  });
  await app.press("id:conflict-file");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "host.openFile")?.payload).toEqual({
    worktree: "/Users/me/vibevalley/.worktrees/issue-31-login",
    path: "src/same.ts",
  });
});
