import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import type { ChatMessage, OrchestratorApproval } from "@vibevalley/protocol";

import { sampleChanges } from "../features/issue/model/issue.samples";
import { responses as artifactResponses } from "../fixtures/artifacts";
import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";
import { fakeHost, type FakeHost } from "./fakeHost";

async function mountApp(route: string, configure?: (fake: FakeHost) => void) {
  const fixture = scenarios.typical;
  const fake = fakeHost(fixture, { route });
  configure?.(fake);
  const app = await open("./main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake, fixture };
}

test("issue draft creation: retry keeps requestKey, mid-flight edit preserves draft and mints new requestKey", async () => {
  let acceptCreate = false;
  let createCalls = 0;

  const { app, fake, fixture } = await mountApp("/issues", (f) => {
    const issue0 = scenarios.typical.state.state.issues.at(0);
    if (!issue0) throw new Error("typical scenario must include baseline issues");
    f.respond("issue.create", () => {
      createCalls++;
      return acceptCreate ? { ...issue0, seq: fixture.state.seq + createCalls } : { bizCode: 300001, message: "Try again" };
    });
    f.respond("issue.refine", () => ({ ...issue0, seq: fixture.state.seq + createCalls + 1 }));
  });

  await app.press("id:issue-new");
  expect(app.enabled("id:issue-new-keep")).toBe(false);
  await app.type("id:issue-new-text", "登录页加一个忘记密码");
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.enabled("id:issue-new-keep"));
  expect(app.count("id:issue-new-dialog")).toBe(1);
  expect(app.enabled("id:issue-new-keep")).toBe(true);

  acceptCreate = true;
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);
  const retryCreates = fake.calls.filter((c) => c.op === "issue.create");
  expect(retryCreates.length).toBe(2);
  expect(retryCreates[1]?.payload).toEqual(retryCreates[0]?.payload);

  fake.clearCalls();
  await app.press("id:issue-new");
  await app.type("id:issue-new-text", "First");
  await app.press("id:issue-new-keep");
  await app.type("id:issue-new-text", "Changed");
  const edited = app.value("id:issue-new-text");
  await fake.pumpUntil(app, () => app.texts().includes("刚才的内容已提交，修改后的草稿已保留。"));
  expect(app.count("id:issue-new-dialog")).toBe(1);
  expect(app.value("id:issue-new-text")).toBe(edited);
  expect(app.texts()).toContain("刚才的内容已提交，修改后的草稿已保留。");
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);
  const editCreates = fake.calls.filter((c) => c.op === "issue.create").map((c) => c.payload as { title: string; requestKey: string });
  expect(editCreates.map((w) => w.title)).toEqual(["First", edited]);
  expect(editCreates[0]?.requestKey).not.toBe(editCreates[1]?.requestKey);
});

test("issue close review: stale tree fetches diff sinceReview before permitting completion", async () => {
  const seenRev = { baseCommit: "base", tree: "seen" };
  const newRev = { baseCommit: "base", tree: "new" };
  let moved = false;

  const { app, fake } = await mountApp("/issues/i31", (f) => {
    const i31 = scenarios.typical.state.state.issues.find((i) => i.id === "i31");
    if (!i31) throw new Error("typical scenario must include i31");
    f.respond("issue.diff.get", () =>
      moved
        ? { ...sampleChanges, revision: newRev, sinceReview: [{ path: "updated.txt", status: "M", added: 1, removed: 0 }] }
        : { ...sampleChanges, revision: seenRev },
    );
    f.respond("issue.review", () => {
      if (moved) return i31;
      moved = true;
      return { bizCode: 300001, message: "review changed" };
    });
    f.respond("issue.status.update", { ...i31, seq: scenarios.typical.state.seq + 10 });
  });

  fake.clearCalls();
  await app.press("id:act-complete");
  await fake.pump(app);
  await app.press("id:review-complete");
  await fake.pumpUntil(app, () => app.count("id:changes-since-review") === 1);
  expect(fake.calls.some((c) => c.op === "issue.status.update")).toBe(false);
  expect(fake.calls.findLast((c) => c.op === "issue.diff.get")?.payload).toEqual({ id: "i31", sinceTree: "seen" });
  expect(app.count("id:changes-since-review")).toBe(1);
  expect(app.texts()).toContain("updated.txt");

  await app.press("id:review-complete");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.status.update"));
  const doneCalls = fake.calls.filter((c) => c.op === "issue.status.update");
  expect(doneCalls.length).toBe(1);
  expect(doneCalls[0]?.payload).toMatchObject({ id: "i31", status: "done", revision: newRev });
});

test("issue clarification: picking an answer option posts the selected response", async () => {
  const { app, fake, fixture } = await mountApp("/issues/i33");
  const i33 = fixture.state.state.issues.find((i) => i.id === "i33");
  const firstOpt = i33?.questions[0]?.options[0];
  if (!firstOpt) throw new Error("i33 must carry at least one question option");

  fake.clearCalls();
  expect(app.count("id:issue-ask")).toBe(1);
  expect(app.count("id:answer-option")).toBeGreaterThan(0);
  await app.press("id:answer-option >> nth=0");
  await fake.pump(app);
  const answerCall = fake.calls.find((c) => c.op === "issue.comment.create" || c.op === "issue.answer");
  expect(answerCall?.payload).toMatchObject({ id: "i33", text: firstOpt });
});

test("chat: composer IME composition, send, live stream, image fallback, and stream drop resilience", async () => {
  const { app, fake, fixture } = await mountApp("/chat");
  fake.clearCalls();

  await app.compose("id:composer-input", "ni");
  expect(fake.calls.some((c) => c.op === "channel.message.send")).toBe(false);
  await app.compose("id:composer-input", "");

  await app.type("id:composer-input", "大家好");
  await app.press("id:send");
  await fake.pump(app);
  const sendCall = fake.calls.find((c) => c.op === "channel.message.send");
  expect(sendCall?.payload).toMatchObject({ id: "general", text: "大家好" });

  const sampleMsg = (fixture.responses["channel.message.list"] as ChatMessage[] | undefined)?.[0];
  if (!sampleMsg) throw new Error("typical scenario must provide chat messages");
  await fake.emit(
    app,
    "channel.follow",
    {
      _tag: "Message",
      message: { ...sampleMsg, id: "m-live-99", number: 99, text: "实时推送到达", at: SCENARIO_NOW },
    },
    (p: unknown) => (p as { id?: string }).id === "general",
  );
  expect(app.texts()).toContain("实时推送到达");

  await app.failImages("file://*");
  await fake.end(app, "channel.follow");
  expect(app.count("id:composer-input")).toBe(1);
  expect(app.texts()).toContain("实时推送到达");
});

test("orchestrator trajectory: polled approval can be granted", async () => {
  let pendingApprovals: OrchestratorApproval[] = [];
  const { app, fake } = await mountApp("/orchestrator/trajectory", (f) => {
    f.respond("orchestrator.approval.list", () => pendingApprovals);
    f.respond("orchestrator.approval.resolve", () => {
      pendingApprovals = [];
      return null;
    });
  });

  await fake.pump(app);
  const clock = app.clock;
  if (!clock) throw new Error("orchestrator approval test requires a manual virtual clock");

  expect(app.count("id:runs-page")).toBe(1);
  fake.clearCalls();
  pendingApprovals = [
    {
      conversationId: "orchestrator",
      taskId: "task-1",
      toolCallId: "tc-allow-1",
      toolName: "issue_create",
      argumentsJson: '{"title":"Approve"}',
      reason: "等待放行高优先级操作",
      requestedAtMs: SCENARIO_NOW,
    },
  ];
  await clock.fastForward(3_100);
  await fake.pump(app);
  expect(app.count("id:approval-allow-tc-allow-1")).toBe(1);
  await app.press("id:approval-allow-tc-allow-1");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "orchestrator.approval.resolve")?.payload).toEqual({
    conversationId: "orchestrator",
    taskId: "task-1",
    toolCallId: "tc-allow-1",
    approved: true,
  });
});

test("pkm: opens notes workspace, lists pages, and switches notes cleanly", async () => {
  const { app, fake } = await mountApp("/pkm");
  expect(app.count("id:pkm")).toBe(1);
  expect(app.count("id:pkm-nav")).toBe(1);
  expect(app.count("id:pkm-list")).toBe(1);
  expect(app.count("id:pkm-row")).toBeGreaterThan(0);

  await app.press("id:pkm-row >> nth=0");
  await fake.pump(app);
  expect(app.count("id:pkm-page")).toBe(1);
  expect(app.count("id:pkm-contents")).toBe(1);
});

test("whiteboard: renders launch timeline elements, adds/undoes nodes, edits inspector, exports SVG, and asks assistant", async () => {
  const { app, fake } = await mountApp("/artifacts/art-launch-board", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
    f.respond("host.saveFile", { saved: true });
  });

  await fake.pumpUntil(app, () => app.count("id:wb-count") === 1 && !app.texts().includes("0 个元素"));
  expect(app.count("id:whiteboard-view")).toBe(1);
  expect(app.count("id:wb-canvas")).toBe(1);

  const countBefore = app.texts().find((s) => s.endsWith("个元素"));
  expect(countBefore).toBeDefined();

  fake.clearCalls();
  await app.press("id:wb-add-node");
  await fake.pumpUntil(app, () => app.texts().find((s) => s.endsWith("个元素")) !== countBefore);
  expect(fake.calls.some((c) => c.op === "artifact.entry.batch")).toBe(true);

  fake.clearCalls();
  expect(app.enabled("id:wb-undo")).toBe(true);
  await app.press("id:wb-undo");
  await fake.pumpUntil(app, () => app.texts().find((s) => s.endsWith("个元素")) === countBefore);
  expect(fake.calls.some((c) => c.op === "artifact.entry.batch")).toBe(true);

  await app.press("id:wb-inspector-toggle");
  expect(app.count("id:wb-inspector")).toBe(1);
  await app.press("id:wb-inspector-item-c-1");
  expect(app.value("id:wb-inspector-label")).toBe("锁定核心范围");
  await app.clear("id:wb-inspector-label");
  await app.type("id:wb-inspector-label", "已锁定 v1 范围");
  fake.clearCalls();
  await app.press("id:wb-inspector-save");
  await fake.pump(app);
  const patchCall = fake.calls.find((c) => c.op === "artifact.entry.batch");
  expect(patchCall).toBeDefined();

  await app.press("id:wb-chat");
  await fake.pump(app);
  expect(app.count("id:artifact-rail")).toBe(1);
  expect(app.count("id:artifact-context-pill")).toBe(1);

  fake.clearCalls();
  await app.press("id:wb-export-svg");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "attachment.create"));
  const svgCall = fake.calls.find((c) => c.op === "attachment.create")?.payload as { type: string; data: string } | undefined;
  expect(svgCall?.type).toBe("image/svg+xml");
  const svgText = new TextDecoder().decode(Uint8Array.from(atob(svgCall?.data ?? ""), (c) => c.charCodeAt(0)));
  expect(svgText).toContain("<svg");
  expect(svgText).toContain("产品发布时间线");
});

test("settings: general settings route renders controls and persists updates", async () => {
  const { app, fake } = await mountApp("/settings/general", (f) => {
    f.respond("setting.update", (p: unknown) => p);
  });

  expect(app.count("id:start-farm")).toBe(1);
  expect(app.count("id:start-workbench")).toBe(1);
  expect(app.count("id:language-zh")).toBe(1);
  expect(app.count("id:language-en")).toBe(1);
  expect(app.count("id:theme-dark")).toBe(1);

  await app.press("id:theme-dark");
  expect(fake.calls.find((c) => c.op === "host.theme")?.payload).toBe("dark");

  await app.press("id:start-farm");

  fake.clearCalls();
  await app.press("id:language-en");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "setting.update")?.payload).toMatchObject({ locale: "en" });
  expect(fake.calls.find((c) => c.op === "host.locale")?.payload).toBe("en");
});
