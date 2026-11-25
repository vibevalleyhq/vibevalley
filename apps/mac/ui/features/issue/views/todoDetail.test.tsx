import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

async function mountTodoIssue() {
  const baseTodo =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo");
  if (!baseTodo) throw new Error("typical scenario must include a backlog or todo issue");
  const { refining: _refining, queuedAt: _queuedAt, ...rest } = baseTodo;
  const draftTodo = { ...rest, status: "backlog" as const, stage: { state: "draft" as const, acts: [] } };
  const state = {
    ...scenarios.typical.state,
    board: {
      ...scenarios.typical.state.board,
      issues: scenarios.typical.state.board.issues.map((i) => (i.id === draftTodo.id ? draftTodo : i)),
    },
  };
  let allowRefine = false;
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${draftTodo.id}` });
  fake.respond("issue.refine", () => (allowRefine ? { ...draftTodo, seq: state.seq + 1 } : { bizCode: 300001, message: "Refine failed" }));
  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-talk") === 1);
  return {
    app,
    fake,
    setAllowRefine: (next: boolean) => {
      allowRefine = next;
    },
  };
}

test("TodoDetail clears draft word optimistically on submit and restores on error only if untouched", async () => {
  const { app, fake, setAllowRefine } = await mountTodoIssue();

  await app.type("id:issue-talk", "Clarify edge cases in parser");
  expect(app.enabled("id:issue-draft")).toBe(true);
  await app.press("id:issue-draft");

  // Cleared synchronously before the server reply is pumped.
  expect(app.value("id:issue-talk")).toBe("");
  expect(fake.calls.some((c) => c.op === "issue.refine")).toBe(true);

  // When the RPC rejects and the input is still empty, restore the failed words.
  await fake.pumpUntil(app, () => app.enabled("id:issue-draft"));
  expect(app.value("id:issue-talk")).toBe("Clarify edge cases in parser");

  // When the user types a follow-up mid-flight, a failure must preserve the newer text.
  await app.press("id:issue-draft");
  expect(app.value("id:issue-talk")).toBe("");
  await app.type("id:issue-talk", "New requirement typed while refining");
  await fake.pumpUntil(app, () => app.enabled("id:issue-draft"));
  expect(app.value("id:issue-talk")).toBe("New requirement typed while refining");

  // Once accepted, the box stays empty.
  setAllowRefine(true);
  await app.press("id:issue-draft");
  expect(app.value("id:issue-talk")).toBe("");
  await fake.pump(app);
  expect(app.value("id:issue-talk")).toBe("");
});
