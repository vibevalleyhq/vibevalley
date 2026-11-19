import "../polyfill";
import { expect, open, test } from "nsh/test";

import type { OrchestratorApproval } from "@vibevalley/protocol";

import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

const approval: OrchestratorApproval = {
  conversationId: "orchestrator",
  taskId: "task-one",
  toolCallId: "call-one",
  toolName: "issue_create",
  argumentsJson: '{"repo":"native","title":"Review the signing change"}',
  reason: "This tool creates an issue",
  requestedAtMs: 1_800_000_000_000,
};
const other = { ...approval, conversationId: "reviewer", taskId: "task-two", toolCallId: "call-two", toolName: "artifact_publish" };
const route = "/orchestrator/trajectory";

test("regression: assistant approvals send the displayed call once and keep each trajectory separate", async () => {
  let pending = [approval, other];
  const fake = fakeHost(
    {
      state,
      responses: {
        ...responses,
        "orchestrator.approval.list": () => pending,
        "orchestrator.approval.resolve": (request: { toolCallId: string }) => {
          pending = pending.filter((item) => item.toolCallId !== request.toolCallId);
          return null;
        },
      },
    },
    { route },
  );
  const app = await open("./main.tsx", { width: 560, height: 760, host: fake.options });
  await fake.pump(app);
  expect(app.texts()).toContain(approval.reason);
  expect(app.texts()).toContain(approval.argumentsJson);
  expect(app.count("id:approval-allow-call-two")).toBe(0);
  await app.press("id:approval-allow-call-one");
  await expect(app.press("id:approval-allow-call-one")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await fake.pump(app);
  expect(app.count("id:orchestrator-approvals")).toBe(0);

  await app.host.send("route", "/orchestrator/reviewer/trajectory");
  await fake.pump(app);
  expect(app.count("id:approval-allow-call-one")).toBe(0);
  await app.press("id:approval-deny-call-two");
  await fake.pump(app);
  expect(app.count("id:orchestrator-approvals")).toBe(0);
  expect(fake.calls.filter((c) => c.op === "orchestrator.approval.list").map((c) => c.payload)).toContainEqual({ conversationId: "reviewer" });
  expect(fake.calls.filter((c) => c.op === "orchestrator.approval.resolve").map((c) => c.payload)).toEqual([
    { conversationId: "orchestrator", taskId: "task-one", toolCallId: "call-one", approved: true },
    { conversationId: "reviewer", taskId: "task-two", toolCallId: "call-two", approved: false },
  ]);
});

test("regression: an open trajectory discovers new approvals and refreshes the queue after a competing decision", async () => {
  let pending: OrchestratorApproval[] = [];
  const fake = fakeHost(
    {
      state,
      responses: {
        ...responses,
        "orchestrator.approval.list": () => pending,
        "orchestrator.approval.resolve": () => {
          pending = [{ ...approval, toolCallId: "next-call" }];
          return { bizCode: 409, message: "Already decided elsewhere" };
        },
      },
    },
    { route },
  );
  const app = await open("./main.tsx", { width: 1100, height: 780, clock: {}, host: fake.options });
  await fake.pump(app);
  expect(app.count("id:orchestrator-approvals")).toBe(0);
  pending = [approval];
  const clock = app.clock;
  if (!clock) throw new Error("The approval polling test needs a manual clock");
  await clock.fastForward(3_100);
  await fake.pump(app);
  await app.press("id:approval-allow-call-one");
  await fake.pump(app);
  expect(app.count("id:approval-allow-call-one")).toBe(0);
  expect(app.count("id:approval-allow-next-call")).toBe(1);
  expect(app.texts()).toContain("Already decided elsewhere");
});
