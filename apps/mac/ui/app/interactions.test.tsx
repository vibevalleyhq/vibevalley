import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import type { Artifact, ArtifactHistoryEntry, ArtifactId, BlockId, ChatMessage, OrchestratorApproval, Suggestion, SuggestionId } from "@vibevalley/protocol";

import { sampleChanges } from "../features/issue/model/issue.samples";
import { responses as artifactResponses } from "../fixtures/artifacts";
import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";
import { fakeHost, type FakeHost } from "./fakeHost";

async function mountApp(route: string, configure?: (fake: FakeHost) => void, opts?: { params?: Record<string, unknown>; reducedMotion?: boolean }) {
  const fixture = scenarios.typical;
  const fake = fakeHost(fixture, { route, ...opts?.params });
  configure?.(fake);
  const app = await open("./main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    reducedMotion: opts?.reducedMotion,
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
    const issue0 = scenarios.typical.state.board.issues.at(0);
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
    const i31 = scenarios.typical.state.board.issues.find((i) => i.id === "i31");
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
  const i33 = fixture.state.board.issues.find((i) => i.id === "i33");
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

test("pkm: deep links remain readable while bare /pkm redirects to newest outline artifact when present", async () => {
  const outlineArt: Artifact = {
    id: "art-outline-1" as ArtifactId,
    title: "每周复盘大纲",
    body: "blocks",
    artifactType: "outline",
    isDefault: false,
    by: "user",
    byName: "用户",
    version: 0,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 10_000,
    updated: SCENARIO_NOW - 5_000,
  };
  const { app, fake } = await mountApp("/pkm/2026-10-14", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
    f.respond("artifact.list", (p: { artifactType?: string }) => (p?.artifactType === "outline" ? [outlineArt] : [outlineArt]));
    f.respond("artifact.get", (p: { id?: string }) => (p?.id === "art-outline-1" ? outlineArt : { bizCode: 100004, message: "not found" }));
    f.respond("artifact.block.list", () => ({ artifact: outlineArt, blocks: [] }));
  });
  expect(app.count("id:pkm-page")).toBe(1);
  expect(app.count("id:content-sidebar")).toBe(1);
  expect(app.count("id:content-nav-notes")).toBe(0);
  expect(app.count("id:content-nav-ai-generate")).toBe(0);
  expect(app.count("id:content-nav-artifact-outline")).toBe(1);

  await app.host.send("route", "/pkm");
  await fake.pumpUntil(app, () => app.count("id:artifacts") === 1 && app.count("id:artifact-blocks") === 1);
  expect(app.count("id:artifact-header")).toBe(1);
  expect(app.value("id:artifact-title")).toBe("每周复盘大纲");
});

test("content hub: binary sidebar, outline template creation via artifact.create, and context memory across places", async () => {
  const created: Artifact[] = [];
  const { app, fake } = await mountApp("/library", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
    f.respond("artifact.create", (p: { title?: string; kind?: string; artifactType?: Artifact["artifactType"]; content?: string }) => {
      const made: Artifact = {
        id: `art-outline-created-${created.length + 1}` as ArtifactId,
        title: p.title ?? "未命名",
        body: p.kind === "store" ? "store" : p.kind === "html" ? "html" : "blocks",
        ...(p.artifactType ? { artifactType: p.artifactType } : {}),
        isDefault: false,
        by: "user",
        byName: "用户",
        version: 0,
        seq: 1,
        versions: [],
        at: SCENARIO_NOW,
        updated: SCENARIO_NOW,
      };
      created.push(made);
      return made;
    });
    f.respond("artifact.get", (p: { id?: string }) => {
      const hit = created.find((a) => a.id === p?.id);
      if (hit) return hit;
      const fn = artifactResponses["artifact.get"] as (arg: unknown) => unknown;
      return fn(p);
    });
    f.respond("artifact.block.list", (p: { id?: string }) => {
      const hit = created.find((a) => a.id === p?.id);
      if (hit) return { artifact: hit, blocks: [] };
      const fn = artifactResponses["artifact.block.list"] as (arg: unknown) => unknown;
      return fn(p);
    });
  });

  expect(app.count("id:library-page")).toBe(1);
  expect(app.count("id:content-sidebar")).toBe(1);
  expect(app.count("id:content-nav-notes")).toBe(0);
  expect(app.count("id:content-nav-ai-generate")).toBe(0);
  expect(app.count("id:content-nav-artifact-outline")).toBe(1);

  fake.clearCalls();
  await app.press("id:content-new-btn");
  await fake.pump(app);
  expect(app.count("id:content-template-modal")).toBe(1);
  await app.press("id:content-template-tpl-note-tech");
  await fake.pumpUntil(app, () => app.count("id:artifacts") === 1 && app.count("id:artifact-blocks") === 1);
  const createCall = fake.calls.find((c) => c.op === "artifact.create");
  expect(createCall?.payload).toMatchObject({ kind: "markdown", artifactType: "outline" });
  expect(fake.calls.some((c) => c.op === "pkm.page.save")).toBe(false);

  fake.clearCalls();
  await app.press("id:content-new-note-btn");
  await fake.pumpUntil(app, () => created.length === 2 && app.value("id:artifact-title") === created[1]?.title);
  expect(fake.calls.find((c) => c.op === "artifact.create")?.payload).toMatchObject({ kind: "markdown", artifactType: "outline" });

  await app.press("id:content-nav-artifacts-all");
  await fake.pump(app);
  expect(app.count("id:library-page")).toBe(1);

  await app.host.send("route", "/artifacts/art-launch-board");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:artifacts")).toBe(1);
  expect(app.count("id:artifact-header")).toBe(1);

  await app.press("id:place-issues");
  await fake.pump(app);
  expect(app.count("id:issues-page")).toBe(1);

  await app.press("id:place-content");
  await fake.pump(app);
  expect(app.count("id:artifacts")).toBe(1);
  expect(app.count("id:artifact-header")).toBe(1);
});

test("presence & durable-cursor suggestions: BlocksView renders live peer pills and accepts/rejects via Tab/Esc", async () => {
  const aid = "art-mine" as ArtifactId;
  const snapFn = artifactResponses["artifact.block.list"] as (p: { id: string }) => { blocks: Array<{ id: BlockId }> };
  const blockId1 = snapFn({ id: aid }).blocks[0]?.id ?? ("art-mine-b11" as BlockId);
  let resolved: { op: string; id: string } | undefined;
  const openSuggestion: Suggestion = {
    id: "sug-durable-1" as SuggestionId,
    artifactId: aid,
    blockId: blockId1,
    author: "w1",
    baseRev: 0, // Stale baseRev, but anchored with Loro durable cursors so still acceptable!
    change: { text: [{ t: "发版前（已修订）", marks: {} }] },
    status: "open",
    createdAt: SCENARIO_NOW,
    cursorStart: "c:start",
    cursorEnd: "c:end",
    startOffset: 0,
    endOffset: 2,
  };

  const { app, fake } = await mountApp("/artifacts/art-mine", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
    f.respond("artifact.suggestion.accept", (p: { suggestion: string }) => {
      resolved = { op: "accept", id: p.suggestion };
      return { ...openSuggestion, status: "accepted" };
    });
    f.respond("artifact.suggestion.reject", (p: { suggestion: string }) => {
      resolved = { op: "reject", id: p.suggestion };
      return { ...openSuggestion, status: "rejected" };
    });
  });

  await fake.pumpUntil(app, () => app.count("id:artifact-blocks") === 1 && app.count("id:artifact-block") > 0);

  await fake.emit(app, "artifact.presence.follow", {
    _tag: "Snapshot",
    peers: [{ id: "session:w1", name: "老周", color: "coral", kind: "block_cursor", blockId: blockId1, offset: 1, status: "润色中", updatedAt: SCENARIO_NOW }],
  });
  await fake.pump(app);
  expect(app.count("id:artifact-presence-pill")).toBe(1);
  expect(app.texts().some((s) => s.includes("老周"))).toBe(true);

  await fake.emit(app, "artifact.presence.follow", { _tag: "Remove", peerId: "session:w1" });
  await fake.pump(app);
  expect(app.count("id:artifact-presence-pill")).toBe(0);

  await fake.emit(app, "artifact.suggestion.follow", {
    _tag: "Suggestions",
    suggestions: [openSuggestion],
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-inline-suggestion") === 1);
  expect(app.enabled("id:inline-suggestion-accept")).toBe(true);

  await app.keyboard.press("tab");
  await fake.pumpUntil(app, () => resolved?.op === "accept");
  expect(resolved).toEqual({ op: "accept", id: "sug-durable-1" });

  resolved = undefined;
  const secondSuggestion: Suggestion = { ...openSuggestion, id: "sug-durable-2" as SuggestionId };
  await fake.emit(app, "artifact.suggestion.follow", {
    _tag: "Suggestions",
    suggestions: [secondSuggestion],
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-inline-suggestion") === 1);
  await app.keyboard.press("escape");
  await fake.pumpUntil(app, () => resolved?.op === "reject");
  expect(resolved).toEqual({ op: "reject", id: "sug-durable-2" });
});

test("whiteboard presence: consumes artifact.presence.follow, publishes via artifact.presence.update, never writes presence/* to batch", async () => {
  const { app, fake } = await mountApp("/artifacts/art-launch-board", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
  });
  await fake.pumpUntil(app, () => app.count("id:whiteboard-view") === 1 && !app.texts().includes("0 个元素"));

  await fake.emit(app, "artifact.presence.follow", {
    _tag: "Upsert",
    peer: { id: "session:helper", name: "老周", color: "teal", kind: "cursor", x: 320, y: 180, status: "连线中", updatedAt: SCENARIO_NOW },
  });
  await fake.pump(app);
  expect(app.count("id:wb-presence-peer")).toBeGreaterThanOrEqual(1);
  expect(app.texts()).toContain("老周 · 连线中");

  await fake.emit(app, "artifact.presence.follow", { _tag: "Remove", peerId: "session:helper" });
  await fake.pump(app);
  expect(app.texts()).not.toContain("老周 · 连线中");

  fake.clearCalls();
  await app.press("id:wb-inspector-toggle");
  await app.press("id:wb-inspector-item-c-1");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "artifact.presence.update"));
  expect(fake.calls.some((c) => c.op === "artifact.presence.update")).toBe(true);
  const batchWrites = fake.calls
    .filter((c) => c.op === "artifact.entry.batch")
    .flatMap((c) => ((c.payload as { writes?: Array<{ path: string }> })?.writes ?? []).map((w) => w.path));
  expect(batchWrites.some((p) => p.startsWith("presence/"))).toBe(false);
});

test("timeline: scrubs history preview and executes restore, fork, and selective undoOrigin", async () => {
  const aid = "art-mine" as ArtifactId;
  const historyEntries: ArtifactHistoryEntry[] = [
    { frontiers: "f-latest", author: "w1", agent: "w1", turn: 2, origin: "session:w1:turn:2", summary: "补充落点线", at: SCENARIO_NOW - 60_000 },
    { frontiers: "f-initial", author: "user", origin: "user", summary: "初始草案", at: SCENARIO_NOW - 300_000 },
  ];
  const { app, fake } = await mountApp("/artifacts/art-mine", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
    f.respond("artifact.history.list", () => historyEntries);
    f.respond("artifact.history.preview", (p: { frontiers: string }) => ({
      artifactId: aid,
      body: "blocks",
      frontiers: p.frontiers,
      entry: historyEntries.find((e) => e.frontiers === p.frontiers),
      blocks: [
        {
          id: "b-prev" as BlockId,
          orderKey: "a0001",
          type: "heading",
          attrs: { level: 2 },
          text: [{ t: "历史快照内容", marks: {} }],
          artifactId: aid,
          rev: 1,
          updatedBy: "user",
          updated: SCENARIO_NOW - 300_000,
        },
      ],
    }));
  });

  await fake.pumpUntil(app, () => app.count("id:artifact-timeline-toggle") === 1);
  await app.press("id:artifact-timeline-toggle");
  await fake.pumpUntil(app, () => app.count("id:artifact-timeline-bar") === 1 && app.count("id:timeline-node-0") === 1);

  fake.clearCalls();
  await app.press("id:timeline-node-0");
  await fake.pumpUntil(app, () => app.count("id:artifact-history-preview") === 1);
  expect(fake.calls.find((c) => c.op === "artifact.history.preview")?.payload).toEqual({ id: aid, frontiers: "f-initial" });
  expect(app.texts()).toContain("历史快照内容");

  fake.clearCalls();
  await app.press("id:timeline-restore");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "artifact.history.restore"));
  expect(fake.calls.find((c) => c.op === "artifact.history.restore")?.payload).toMatchObject({ id: aid, frontiers: "f-initial" });

  await fake.pumpUntil(app, () => app.count("id:timeline-node-1") === 1);
  await app.press("id:timeline-node-1");
  await fake.pump(app);
  fake.clearCalls();
  await app.press("id:timeline-undo-origin");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "artifact.history.undoOrigin"));
  expect(fake.calls.find((c) => c.op === "artifact.history.undoOrigin")?.payload).toEqual({ id: aid, origin: "session:w1:turn:2" });

  fake.clearCalls();
  await app.press("id:timeline-fork");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "artifact.history.fork"));
  expect(fake.calls.find((c) => c.op === "artifact.history.fork")?.payload).toMatchObject({ id: aid, frontiers: "f-latest" });
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
  expect(app.count("id:artifact-rail")).toBe(0);

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

test("settings: appearance motion control dispatches host.motion, syncs host events, and applies off mode", async () => {
  const { app, fake } = await mountApp(
    "/settings/general",
    (f) => {
      f.respond("host.info", { capabilities: ["theme", "motion"], motion: "on" });
      f.respond("host.motion", null);
    },
    { params: { motion: "system" } },
  );

  expect(app.count("id:motion-off")).toBe(1);
  expect(app.count("id:motion-on")).toBe(1);
  expect(app.count("id:motion-system")).toBe(1);
  expect(app.viewStyle("id:motion-on")?.backgroundColor).toBeTruthy();
  expect(app.viewStyle("id:motion-off")?.backgroundColor).toBeUndefined();

  fake.clearCalls();
  await app.press("id:motion-off");
  await fake.pump(app);
  expect(app.viewStyle("id:motion-off")?.backgroundColor).toBeTruthy();
  expect(app.viewStyle("id:motion-on")?.backgroundColor).toBeUndefined();

  await app.press("id:motion-system");
  await fake.pump(app);
  expect(app.viewStyle("id:motion-system")?.backgroundColor).toBeTruthy();

  await app.press("id:motion-on");
  await fake.pump(app);
  expect(app.viewStyle("id:motion-on")?.backgroundColor).toBeTruthy();
  expect(fake.calls.filter((c) => c.op === "host.motion").map((c) => c.payload)).toEqual(["off", "system", "on"]);

  fake.clearCalls();
  await app.host.send("motion", "off");
  await fake.pump(app);
  expect(app.viewStyle("id:motion-off")?.backgroundColor).toBeTruthy();
  expect(fake.calls.some((c) => c.op === "host.motion")).toBe(false);

  await app.press("id:place-issues");
  await fake.pump(app);
  await app.press("id:issue-new");
  expect(app.count("id:issue-new-dialog")).toBe(1);
  expect(app.viewStyle("id:issue-new-dialog")?.effectiveOpacity).toBe(1);
  await app.keyboard.press("escape");
  expect(app.count("id:issue-new-dialog")).toBe(0);

  const bootOff = await mountApp(
    "/settings/general",
    (f) => {
      f.respond("host.info", { capabilities: ["theme", "motion"], motion: "off" });
    },
    { params: { motion: "off" } },
  );
  expect(bootOff.app.viewStyle("id:motion-off")?.backgroundColor).toBeTruthy();
  expect(bootOff.app.viewStyle("id:motion-system")?.backgroundColor).toBeUndefined();
});

test("regression: whiteboard ChannelSidePane survives artifact polling, remount after ready, and slice updates without dropping channel.follow", async () => {
  const { app, fake, fixture } = await mountApp("/artifacts/art-launch-board", (f) => {
    for (const [op, handler] of Object.entries(artifactResponses)) {
      f.respond(op, handler);
    }
    f.respond("channel.message.list", []);
    f.respond("channel.message.send", null);
  });
  const clock = app.clock;
  if (!clock) throw new Error("whiteboard chat regression test requires a manual virtual clock");

  await fake.pumpUntil(app, () => app.count("id:wb-count") === 1 && !app.texts().includes("0 个元素"));

  // Open chat once so `followed.get("general").ready` transitions to `true`, then toggle closed and open
  // so `followChannel` runs synchronously inside `useFollowed`'s `createEffect` owner.
  await app.press("id:wb-chat");
  await fake.pump(app);
  expect(app.count("id:artifact-chat-pane")).toBe(1);
  await app.press("id:artifact-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:artifact-chat-pane")).toBe(0);
  await app.press("id:artifact-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:artifact-chat-pane")).toBe(1);

  await app.type("id:composer-input", "帮我优化一下呢？");
  // The 5-second `useArtifact` poll must not remount `ChannelSidePane` or wipe the active draft.
  await clock.fastForward(5_500);
  await fake.pump(app);
  expect(app.value("id:composer-input")).toBe("帮我优化一下呢？");

  fake.clearCalls();
  await app.press("id:send");
  await fake.pump(app);
  const sendCall = fake.calls.find((c) => c.op === "channel.message.send");
  const sendPayload = sendCall?.payload as
    | { id?: string; text?: string; sendKey?: string; viewContext?: { artifactType?: string; title?: string } }
    | undefined;
  expect(sendPayload).toMatchObject({
    id: "general",
    text: "帮我优化一下呢？",
    viewContext: { artifactType: "whiteboard", title: "产品发布时间线" },
  });
  expect(sendPayload?.sendKey).toBeTruthy();
  expect(app.count("id:pending-line-sending")).toBe(1);

  await fake.setState(app, { ...fixture.state });

  const sampleMsg = (fixture.responses["channel.message.list"] as ChatMessage[] | undefined)?.[0];
  if (!sampleMsg) throw new Error("typical scenario must provide chat messages");
  await fake.emit(
    app,
    "channel.follow",
    {
      _tag: "Message",
      message: {
        ...sampleMsg,
        id: "m-wb-1",
        channel: "general",
        number: 1,
        revision: 2,
        from: "user",
        actor: { kind: "user", id: "user", name: "用户" },
        name: "用户",
        text: "帮我优化一下呢？",
        sendKey: sendPayload?.sendKey,
        at: SCENARIO_NOW,
        viewContext: { artifactId: "art-launch-board", artifactType: "whiteboard", title: "产品发布时间线", seq: 2 },
      },
    },
    (p: unknown) => (p as { id?: string }).id === "general",
  );
  await fake.pump(app);

  expect(app.count("id:message-1")).toBe(1);
  expect(app.texts()).toContain("帮我优化一下呢？");
  expect(app.count("id:pending-line-sending")).toBe(0);
  expect(app.count("id:pending-line-failed")).toBe(0);

  // Even when the originating ChannelSidePane unmounts while a send intent still holds the channel
  // subscription open, the detached `host.on("sub:<id>")` listener must keep delivering events.
  fake.clearCalls();
  await app.type("id:composer-input", "第二条也发出去");
  await app.press("id:send");
  await fake.pump(app);
  const secondSend = fake.calls.find((c) => c.op === "channel.message.send")?.payload as { sendKey?: string } | undefined;
  expect(secondSend?.sendKey).toBeTruthy();

  await app.press("id:artifact-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:artifact-chat-pane")).toBe(0);

  await fake.emit(
    app,
    "channel.follow",
    {
      _tag: "Message",
      message: {
        ...sampleMsg,
        id: "m-wb-2",
        channel: "general",
        number: 2,
        revision: 3,
        from: "user",
        actor: { kind: "user", id: "user", name: "用户" },
        name: "用户",
        text: "第二条也发出去",
        sendKey: secondSend?.sendKey,
        at: SCENARIO_NOW + 1_000,
        viewContext: { artifactId: "art-launch-board", artifactType: "whiteboard", title: "产品发布时间线", seq: 2 },
      },
    },
    (p: unknown) => (p as { id?: string }).id === "general",
  );
  await app.press("id:artifact-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:message-2")).toBe(1);
  expect(app.texts()).toContain("第二条也发出去");
  expect(app.count("id:pending-line-sending")).toBe(0);
  expect(app.count("id:pending-line-failed")).toBe(0);

  // Past the 20s `chatSay` timeout, no phantom failure line appears.
  await clock.fastForward(21_000);
  await fake.pump(app);
  expect(app.count("id:pending-line-failed")).toBe(0);
});
