import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import type { Attachment } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

async function mountTodoIssue(overrides?: { attachments?: Attachment[]; description?: string; criteria?: string[]; title?: string }) {
  const baseTodo =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo");
  if (!baseTodo) throw new Error("typical scenario must include a backlog or todo issue");
  const { refining: _refining, queuedAt: _queuedAt, ...rest } = baseTodo;
  const draftTodo = {
    ...rest,
    ...(overrides?.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides?.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides?.criteria !== undefined ? { criteria: overrides.criteria } : {}),
    ...(overrides?.attachments ? { attachments: overrides.attachments } : {}),
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
  fake.respond("attachment.file", (payload: unknown) => {
    const id = (payload as { id?: string } | undefined)?.id ?? "";
    return { path: `/tmp/${id}.png`, type: "image/png", name: `${id}.png` };
  });
  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-title") === 1);
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

  // If the draft already has content, open the refine textarea via the quiet toggle; otherwise it is shown immediately.
  if (app.count("id:issue-talk") === 0) {
    await app.press("id:issue-draft-toggle");
    await fake.pumpUntil(app, () => app.count("id:issue-talk") === 1);
  }

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
  const { app, fake } = await mountTodoIssue({ attachments: files });

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

test("TodoDetail defaults to preview-first Markdown, Compare, visual criteria checklist, and calm action bar with click-to-edit", async () => {
  const longTitle =
    "Investigate and redesign the multi-repository draft issue title input so titles over sixty characters wrap cleanly without horizontal clipping";
  const compareMarkdown = [
    "## Summary",
    "Render formatted **Markdown** and interactive Before/After visual comparisons directly on draft issues.",
    "",
    "```compare",
    JSON.stringify({
      title: "Draft Detail Visual Check",
      before: { attachment: "att-before", label: "Before" },
      after: { attachment: "att-after", label: "After" },
    }),
    "```",
  ].join("\n");

  const { app, fake } = await mountTodoIssue({
    title: longTitle,
    description: compareMarkdown,
    criteria: ["Markdown headings and Compare slider render by default", "Editing controls toggle inline cleanly"],
  });

  // Preview-first state: wrapping text title, Markdown + Compare preview, visual criteria rows, and calm action bar hiding issue-talk.
  expect(app.texts()).toContain(longTitle);
  expect(app.count("id:issue-title-input")).toBe(0);
  expect(app.count("id:issue-description-preview")).toBe(1);
  expect(app.count("id:compare-card")).toBe(1);
  expect(app.count("id:issue-description")).toBe(0);
  expect(app.count("id:issue-criteria-preview")).toBe(1);
  expect(app.count("id:todo-criterion")).toBe(2);
  expect(app.count("id:issue-criteria-input")).toBe(0);
  expect(app.count("id:issue-talk")).toBe(0);
  expect(app.count("id:issue-draft-toggle")).toBe(1);

  const titleBox = app.layout("id:issue-title");
  expect(titleBox).toBeDefined();
  expect(titleBox!.height).toBeGreaterThan(44);

  // Clicking title toggles inline multiline edit; typing and pressing Enter commits into preview title.
  await app.press("id:issue-title-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-title-input") === 1);
  await app.type("id:issue-title-input", " updated");
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => app.count("id:issue-title-input") === 0);
  expect(app.texts().join("\n")).toContain("updated");

  // Re-opening title edit and pressing Escape discards unsaved edits.
  await app.press("id:issue-title-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-title-input") === 1);
  await app.type("id:issue-title-input", " discarded");
  await app.keyboard.press("escape");
  await fake.pumpUntil(app, () => app.count("id:issue-title-input") === 0);
  expect(app.texts().join("\n")).not.toContain("discarded");

  // Clicking Edit on description switches to multiline textarea and Done returns to rendered preview.
  await app.press("id:issue-edit-description");
  await fake.pumpUntil(app, () => app.count("id:issue-description") === 1);
  await app.press("id:issue-edit-description-done");
  await fake.pumpUntil(app, () => app.count("id:issue-description-preview") === 1 && app.count("id:compare-card") === 1);

  // Clicking Edit on criteria switches to textarea and Done returns to visual checklist.
  await app.press("id:issue-edit-criteria");
  await fake.pumpUntil(app, () => app.count("id:issue-criteria-input") === 1);
  await app.press("id:issue-edit-criteria-done");
  await fake.pumpUntil(app, () => app.count("id:issue-criteria-preview") === 1 && app.count("id:todo-criterion") === 2);

  // Clicking the quiet refine toggle reveals the compact refine textarea.
  await app.press("id:issue-draft-toggle");
  await fake.pumpUntil(app, () => app.count("id:issue-talk") === 1);
});

test("TodoDetail displays agent.validate readiness diagnostics and can mount a local repository", async () => {
  const { app, fake } = await mountTodoIssue();
  fake.respond("agent.validate", [
    { id: "ahua", problems: [{ field: "runtime", level: "error", text: "OpenCode 没装" }] },
    { id: "xiaolin", problems: [{ field: "persona", level: "warn", text: "还没写人设" }] },
  ]);
  fake.respond("host.pickFolder", () => ({ path: "/Users/dev/local-repo", name: "local-repo", git: true }));
  fake.respond("repo.mount", () => ({
    name: "local-repo",
    path: "/Users/dev/local-repo",
    git: true,
    external: true,
    maxSessions: 2,
    pullRequest: { available: false, reason: "" },
  }));

  await fake.pumpUntil(app, () => app.count("id:issue-helper") === 1);
  await app.press("id:issue-helper");
  await fake.pump(app);
  await app.press("text:小林");
  await fake.pumpUntil(app, () => app.count("id:issue-helper-status") === 1);
  expect(app.texts()).toContain("还没写人设");

  await app.press("id:mount-local-repo");
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "repo.mount")).toBe(true);
});
