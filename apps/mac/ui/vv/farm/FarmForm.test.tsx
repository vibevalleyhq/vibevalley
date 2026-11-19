import "../polyfill";
import { expect, open, test } from "nsh/test";

import { fakeHost } from "../app/fakeHost";
import { withIssues } from "../fixtures/issues";
import { responses, state } from "../fixtures/workbench";
import { sampleChanges } from "../web/features/issue/model/issue.samples";

const fixture = withIssues({ state, responses });

test("regression: a plot answer reaches its issue thread", async () => {
  const fake = fakeHost(fixture, { view: "farm-form", kind: "inspect", issue: "i33" });
  const app = await open("../../App.tsx", { width: 560, height: 550, host: fake.options });
  await fake.pump(app);
  expect(app.count("id:plot-answer-option")).toBe(2);
  await app.press("text:回登录页");
  await fake.pump(app);
  const call = fake.calls.find((c) => c.op === "issue.comment.create");
  expect(call?.payload).toMatchObject({ id: "i33", text: "回登录页" });
});

test("regression: harvest keeps a changed plot open until the new tree is reviewed", async () => {
  const subject = fixture.state.state.issues.find((i) => i.id === "i31");
  const original = { baseCommit: "base", tree: "reviewed" };
  const next = { ...original, tree: "updated" };
  let moved = false;
  const fake = fakeHost(
    {
      state: fixture.state,
      responses: {
        ...fixture.responses,
        "issue.diff.get": () =>
          moved
            ? { ...sampleChanges, revision: next, sinceReview: [{ path: "new.txt", status: "A", added: 1, removed: 0 }] }
            : { ...sampleChanges, revision: original },
        "issue.review": () => {
          if (moved) return subject;
          moved = true;
          return { bizCode: 300001, message: "review changed" };
        },
        "issue.status.update": { ...subject, seq: 1 },
      },
    },
    { view: "farm-form", kind: "harvest", issue: "i31" },
  );
  const app = await open("../../App.tsx", { width: 560, height: 550, host: fake.options });
  await fake.pump(app);
  await app.press("id:harvest-take");
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "issue.status.update")).toBe(false);
  expect(fake.calls.filter((c) => c.op === "issue.diff.get").at(-1)?.payload).toEqual({ id: "i31", sinceTree: original.tree });
  expect(app.texts()).toContain("A new.txt");
  await app.press("id:harvest-take");
  await fake.pump(app);
  expect(fake.calls.filter((c) => ["issue.review", "issue.status.update"].includes(c.op)).map((c) => c.payload)).toEqual([
    { id: "i31", pass: true, revision: original },
    { id: "i31", pass: true, revision: next },
    { id: "i31", status: "done", revision: next },
  ]);
});
