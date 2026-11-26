import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import type { Attachment } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

async function mountTodoIssue(attachments?: Attachment[]) {
  const baseTodo =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo");
  if (!baseTodo) throw new Error("typical scenario must include a backlog or todo issue");
  const { refining: _refining, queuedAt: _queuedAt, ...rest } = baseTodo;
  const draftTodo = {
    ...rest,
    ...(attachments ? { attachments } : {}),
    status: "backlog" as const,
    stage: { state: "draft" as const, acts: [] },
  };
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
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { attachments?: string[] };
    const ids = p.attachments;
    const nextAttachments = ids ? (draftTodo.attachments ?? []).filter((a) => ids.includes(a.id)) : draftTodo.attachments;
    return { ...draftTodo, ...(nextAttachments ? { attachments: nextAttachments } : {}), seq: state.seq + 1 };
  });
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
    draftTodo,
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

test("TodoDetail renders issue attachments and persists removed attachments on Save", async () => {
  const files: Attachment[] = [
    { id: "att-spec", name: "spec.pdf", type: "application/pdf", size: 2048 },
    { id: "att-log", name: "trace.txt", type: "text/plain", size: 512 },
  ];
  const { app, fake } = await mountTodoIssue(files);

  expect(app.count("id:issue-attachments")).toBe(1);
  expect(app.count("id:issue-attachment-item")).toBe(2);
  expect(app.count("id:issue-save")).toBe(0);

  await app.press("id:issue-attachment-remove-att-spec");
  await fake.pumpUntil(app, () => app.count("id:issue-attachment-item") === 1);
  expect(app.count("id:issue-save")).toBe(1);

  await app.press("id:issue-save");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));

  const updateCall = fake.calls.find((c) => c.op === "issue.update");
  expect((updateCall?.payload as { attachments?: string[] } | undefined)?.attachments).toEqual(["att-log"]);
});

test("TodoDetail wraps long draft titles without truncation and uses compact description min-height", async () => {
  const longTitle =
    "Investigate and redesign the multi-repository draft issue title input so titles over sixty characters wrap cleanly without horizontal clipping";
  const baseTodo =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo");
  if (!baseTodo) throw new Error("typical scenario must include a backlog or todo issue");
  const { refining: _refining, queuedAt: _queuedAt, ...rest } = baseTodo;
  const draftTodo = {
    ...rest,
    title: longTitle,
    description: "Short draft summary.",
    status: "backlog" as const,
    stage: { state: "draft" as const, acts: [] },
  };
  const state = {
    ...scenarios.typical.state,
    board: {
      ...scenarios.typical.state.board,
      issues: scenarios.typical.state.board.issues.map((i) => (i.id === draftTodo.id ? draftTodo : i)),
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${draftTodo.id}` });
  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-title") === 1 && app.count("id:issue-description") === 1);

  expect(app.value("id:issue-title")).toBe(longTitle);
  const titleBox = app.layout("id:issue-title");
  expect(titleBox).toBeDefined();
  // Multiline title wraps across >= 2 lines (> single-line ~42px height).
  expect(titleBox!.height).toBeGreaterThan(56);

  // Typing into the multiline title field stays interactive and updates the draft value.
  await app.type("id:issue-title", " updated");
  expect(app.value("id:issue-title")).toContain("updated");

  // Short description box uses the tighter 88px minimum height rather than the old 144px gap.
  const descBox = app.layout("id:issue-description");
  expect(descBox).toBeDefined();
  expect(descBox!.height).toBeGreaterThanOrEqual(88);
  expect(descBox!.height).toBeLessThan(120);
});
