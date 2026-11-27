import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import type { ChatMessage, Note, NoteHistoryEntry, NoteId, NoteType, OrchestratorApproval, Suggestion, SuggestionId } from "@vibevalley/protocol";

import { sampleChanges } from "../features/issue/model/issue.samples";
import { fakeHost, type FakeHost } from "../fixtures/fakeHost";
import { responses as noteResponses } from "../fixtures/notes";
import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";

async function mountApp(
  route: string,
  configure?: (fake: FakeHost) => void,
  opts?: { params?: Record<string, unknown>; reducedMotion?: boolean; storage?: Record<string, string> },
) {
  const fixture = scenarios.typical;
  const fake = fakeHost(fixture, { route, ...opts?.params });
  configure?.(fake);
  const app = await open("./main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    reducedMotion: opts?.reducedMotion,
    storage: opts?.storage,
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

test("directory note files: lists, edits, and saves via note.file.{list,get,write}", async () => {
  const docNote = (noteResponses["note.list"] as { toJSON: () => Note[] }).toJSON().find((n) => n.noteType === "doc");
  if (!docNote) throw new Error("notes fixture must provide a doc note");
  const { app, fake } = await mountApp(`/notes/${docNote.id}`, (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
  });

  await fake.pumpUntil(app, () => app.count("id:note-header") === 1);
  await app.press("id:note-more");
  await fake.pumpUntil(app, () => app.count("id:note-view-mode") === 1);
  await app.press("id:note-view-mode");
  await fake.pumpUntil(app, () => app.count("id:note-directory-view") === 1 && fake.calls.some((c) => c.op === "note.file.get"));
  expect(fake.calls.some((c) => c.op === "note.file.list")).toBe(true);
});

test("regression: genui block inside channel message dispatches onGenUiAction with reactive state and toast feedback", async () => {
  const genuiMd = [
    "```genui",
    '{"op":"title","title":"Release Gate"}',
    '{"op":"state_init","state":{"approved":false}}',
    '{"op":"set_node","root":true,"node":{"id":"root","kind":"switch","bind":"approved","label":"Approve release"}}',
    '{"op":"done"}',
    "```",
  ].join("\n");

  const { app, fake, fixture } = await mountApp("/chat");
  const sampleMsg = (fixture.responses["channel.message.list"] as ChatMessage[] | undefined)?.[0];
  if (!sampleMsg) throw new Error("typical scenario must provide chat messages");

  await fake.emit(
    app,
    "channel.follow",
    {
      _tag: "Message",
      message: { ...sampleMsg, id: "m-genui-1", number: 120, text: genuiMd, at: SCENARIO_NOW },
    },
    (p: unknown) => (p as { id?: string }).id === "general",
  );
  await fake.pumpUntil(app, () => app.count("id:genui-switch-root") === 1);

  await app.press("id:genui-switch-root");
  await fake.pumpUntil(app, () => app.texts().includes("approved=true"));
  expect(app.texts()).toContain("approved=true");
  expect(app.texts()).toContain("Approve release: on");
});

test("content hub: 3+1 sidebar, doc template creation via note.create, and context memory across places", async () => {
  const created: Note[] = [];
  const { app, fake } = await mountApp("/library", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
    f.respond("note.create", (p: { title?: string; noteType?: NoteType }) => {
      const made: Note = {
        id: `note-doc-created-${created.length + 1}` as NoteId,
        title: p.title ?? "未命名",
        noteType: p.noteType ?? "doc",
        sortOrder: 1,
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
    f.respond("note.get", (p: { id?: string }) => {
      const hit = created.find((n) => n.id === p?.id);
      if (hit) return hit;
      const fn = noteResponses["note.get"] as (arg: unknown) => unknown;
      return fn(p);
    });
    f.respond("note.file.list", (p: { id?: string }) => {
      const hit = created.find((n) => n.id === p?.id);
      if (hit) return { noteId: hit.id, seq: 1, files: [] };
      const fn = noteResponses["note.file.list"] as (arg: unknown) => unknown;
      return fn(p);
    });
  });

  expect(app.count("id:library-page")).toBe(1);
  expect(app.count("id:desk")).toBe(0);
  expect(app.count("id:content-sidebar")).toBe(1);
  expect(app.count("id:content-nav-note-doc")).toBe(1);
  expect(app.count("id:content-nav-note-base")).toBe(1);
  expect(app.count("id:content-nav-note-canvas")).toBe(1);
  expect(app.count("id:content-nav-note-media")).toBe(1);

  await app.press("id:content-sidebar-toggle");
  await fake.pump(app);
  expect(app.count("id:content-sidebar")).toBe(0);
  expect(app.count("id:content-sidebar-toggle")).toBe(1);
  await app.press("id:content-sidebar-toggle");
  await fake.pump(app);
  expect(app.count("id:content-sidebar")).toBe(1);

  fake.clearCalls();
  await app.press("id:content-nav-note-doc");
  await fake.pump(app);
  await app.press("id:content-new-btn");
  await fake.pump(app);
  expect(app.count("id:content-template-modal")).toBe(1);
  expect(app.count("id:content-template-tpl-note-tech")).toBe(1);
  await app.press("id:content-template-tpl-note-tech");
  await fake.pumpUntil(app, () => app.count("id:notes") === 1 && app.count("id:note-header") === 1);
  const createCall = fake.calls.find((c) => c.op === "note.create");
  expect(createCall?.payload).toMatchObject({ noteType: "doc" });
  expect(app.texts()).toContain(created[0]?.title);

  await app.press("id:content-nav-notes-all");
  await fake.pump(app);
  expect(app.count("id:library-page")).toBe(1);

  await app.host.send("route", "/notes/art-launch-board");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:notes")).toBe(1);
  expect(app.count("id:desk")).toBe(0);
  expect(app.count("id:note-header")).toBe(1);
  expect(app.count("id:note-more")).toBe(1);
  expect(app.count("id:note-view-mode")).toBe(0);
  await app.press("id:note-more");
  await fake.pumpUntil(app, () => app.count("id:note-view-mode") === 1);
  await app.keyboard.press("escape");
  await fake.pumpUntil(app, () => app.count("id:note-view-mode") === 0);

  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(1);
  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(0);

  await app.press("id:place-issues");
  await fake.pump(app);
  expect(app.count("id:issues-page")).toBe(1);

  await app.press("id:place-content");
  await fake.pump(app);
  expect(app.count("id:notes")).toBe(1);
  expect(app.count("id:note-header")).toBe(1);
});

test("presence & file suggestions: NoteDirectoryView renders live peer pills and accepts/rejects via Tab/Esc", async () => {
  const nid = "art-mine" as NoteId;
  let resolved: { op: string; id: string } | undefined;
  const openSuggestion: Suggestion = {
    id: "sug-durable-1" as SuggestionId,
    noteId: nid,
    path: "structure/base.json",
    author: "w1",
    baseRev: 1,
    change: { content: '{"version":1,"sheets":[]}', summary: "发版前（已修订）" },
    status: "open",
    createdAt: SCENARIO_NOW,
    cursorStart: "c:start",
    cursorEnd: "c:end",
    startOffset: 0,
    endOffset: 2,
  };

  const { app, fake } = await mountApp("/notes/art-mine", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
    f.respond("note.suggestion.accept", (p: { suggestion: string }) => {
      resolved = { op: "accept", id: p.suggestion };
      return { ...openSuggestion, status: "accepted" };
    });
    f.respond("note.suggestion.reject", (p: { suggestion: string }) => {
      resolved = { op: "reject", id: p.suggestion };
      return { ...openSuggestion, status: "rejected" };
    });
  });

  await fake.pumpUntil(app, () => app.count("id:note-header") === 1);

  await fake.emit(app, "note.presence.follow", {
    _tag: "Snapshot",
    peers: [
      {
        id: "session:w1",
        name: "老周",
        color: "coral",
        kind: "cursor",
        path: "structure/base.json",
        nodeId: "r1",
        offset: 1,
        status: "润色中",
        updatedAt: SCENARIO_NOW,
      },
    ],
  });
  await fake.pump(app);
  expect(app.count("id:note-presence-pill")).toBe(1);
  expect(app.texts().some((s) => s.includes("老周"))).toBe(true);

  await fake.emit(app, "note.presence.follow", { _tag: "Remove", peerId: "session:w1" });
  await fake.pump(app);
  expect(app.count("id:note-presence-pill")).toBe(0);

  await fake.emit(app, "note.suggestion.follow", {
    _tag: "Suggestions",
    suggestions: [openSuggestion],
  });
  await fake.pumpUntil(app, () => app.count("id:note-inline-suggestion") === 1);
  expect(app.enabled("id:inline-suggestion-accept")).toBe(true);

  await app.keyboard.press("tab");
  await fake.pumpUntil(app, () => resolved?.op === "accept");
  expect(resolved).toEqual({ op: "accept", id: "sug-durable-1" });

  resolved = undefined;
  const secondSuggestion: Suggestion = { ...openSuggestion, id: "sug-durable-2" as SuggestionId };
  await fake.emit(app, "note.suggestion.follow", {
    _tag: "Suggestions",
    suggestions: [secondSuggestion],
  });
  await fake.pumpUntil(app, () => app.count("id:note-inline-suggestion") === 1);
  await app.keyboard.press("escape");
  await fake.pumpUntil(app, () => resolved?.op === "reject");
  expect(resolved).toEqual({ op: "reject", id: "sug-durable-2" });
});

test("whiteboard presence: consumes note.presence.follow, publishes via note.presence.update, never writes presence/* to file.write", async () => {
  const { app, fake } = await mountApp("/notes/art-launch-board", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
  });
  await fake.pumpUntil(app, () => app.count("id:whiteboard-view") === 1 && !app.texts().includes("0 个元素"));

  await fake.emit(app, "note.presence.follow", {
    _tag: "Upsert",
    peer: { id: "session:helper", name: "老周", color: "teal", kind: "cursor", x: 320, y: 180, status: "连线中", updatedAt: SCENARIO_NOW },
  });
  await fake.pump(app);
  expect(app.count("id:wb-presence-peer")).toBeGreaterThanOrEqual(1);
  expect(app.texts()).toContain("老周 · 连线中");

  await fake.emit(app, "note.presence.follow", { _tag: "Remove", peerId: "session:helper" });
  await fake.pump(app);
  expect(app.texts()).not.toContain("老周 · 连线中");

  fake.clearCalls();
  await app.press("id:wb-inspector-toggle");
  await app.press("id:wb-inspector-item-c-1");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.presence.update"));
  expect(fake.calls.some((c) => c.op === "note.presence.update")).toBe(true);
  const writtenPaths = fake.calls
    .filter((c) => c.op === "note.file.write")
    .flatMap((c) => ((c.payload as { files?: Array<{ path: string }> })?.files ?? []).map((w) => w.path));
  expect(writtenPaths.some((p) => p.startsWith("presence/"))).toBe(false);
});

test("history panel: opens on right rail, previews commit, restores, forks, saves snapshot, and selectively undoes origin", async () => {
  const nid = "art-mine" as NoteId;
  const historyEntries: NoteHistoryEntry[] = [
    { frontiers: "f-latest", author: "w1", agent: "w1", turn: 2, origin: "session:w1:turn:2", summary: "补充落点线", at: SCENARIO_NOW - 60_000 },
    { frontiers: "f-initial", author: "user", origin: "user", summary: "初始草案", at: SCENARIO_NOW - 300_000 },
  ];
  const { app, fake } = await mountApp("/notes/art-mine", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
    f.respond("note.history.list", () => historyEntries);
    f.respond("note.history.preview", (p: { frontiers: string }) => ({
      noteId: nid,
      noteType: "base",
      frontiers: p.frontiers,
      entry: historyEntries.find((e) => e.frontiers === p.frontiers),
      files: [
        {
          noteId: nid,
          path: "structure/base.json",
          mime: "application/json",
          encoding: "utf8",
          content: "历史快照内容",
          size: 18,
          hash: "abc123",
          updatedAt: SCENARIO_NOW - 300_000,
        },
      ],
    }));
  });

  await fake.pumpUntil(app, () => app.count("id:note-history-toggle") === 1);
  await app.press("id:note-history-toggle");
  await fake.pumpUntil(app, () => app.count("id:note-history-panel") === 1 && app.count("id:history-commit-1") === 1);

  fake.clearCalls();
  await app.press("id:history-commit-1");
  await fake.pumpUntil(app, () => app.count("id:history-preview-files") === 1);
  expect(fake.calls.find((c) => c.op === "note.history.preview")?.payload).toEqual({ id: nid, frontiers: "f-initial" });
  expect(app.texts()).toContain("历史快照内容");

  fake.clearCalls();
  await app.press("id:history-restore");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.history.restore"));
  expect(fake.calls.find((c) => c.op === "note.history.restore")?.payload).toMatchObject({ id: nid, frontiers: "f-initial" });

  await fake.pumpUntil(app, () => app.count("id:history-commit-0") === 1);
  await app.press("id:history-commit-0");
  await fake.pumpUntil(app, () => app.enabled("id:history-undo-origin"));
  fake.clearCalls();
  await app.press("id:history-undo-origin");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.history.undoOrigin"));
  expect(fake.calls.find((c) => c.op === "note.history.undoOrigin")?.payload).toEqual({ id: nid, origin: "session:w1:turn:2" });

  await fake.pumpUntil(app, () => app.count("id:history-save-snapshot") === 1);
  fake.clearCalls();
  await app.press("id:history-save-snapshot");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.version.create"));

  await fake.pumpUntil(app, () => app.enabled("id:history-fork"));
  fake.clearCalls();
  await app.press("id:history-fork");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.history.fork"));
  expect(fake.calls.find((c) => c.op === "note.history.fork")?.payload).toMatchObject({ id: nid, frontiers: "f-latest" });
});

test("whiteboard: renders launch timeline elements, adds/undoes nodes via note.file.write, edits inspector, exports SVG, and asks assistant", async () => {
  const { app, fake } = await mountApp("/notes/art-launch-board", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
    f.respond("host.saveFile", { saved: true });
  });

  await fake.pumpUntil(app, () => app.count("id:wb-count") === 1 && !app.texts().includes("0 个元素"));
  expect(app.count("id:whiteboard-view")).toBe(1);
  expect(app.count("id:wb-canvas")).toBe(1);
  expect(app.count("id:note-rail")).toBe(0);

  const countBefore = app.texts().find((s) => s.endsWith("个元素"));
  expect(countBefore).toBeDefined();

  fake.clearCalls();
  await app.press("id:wb-add-node");
  await fake.pumpUntil(app, () => app.texts().find((s) => s.endsWith("个元素")) !== countBefore);
  expect(fake.calls.some((c) => c.op === "note.file.write")).toBe(true);

  fake.clearCalls();
  expect(app.enabled("id:wb-undo")).toBe(true);
  await app.press("id:wb-undo");
  await fake.pumpUntil(app, () => app.texts().find((s) => s.endsWith("个元素")) === countBefore);
  expect(fake.calls.some((c) => c.op === "note.file.write")).toBe(true);

  await app.press("id:wb-inspector-toggle");
  expect(app.count("id:wb-inspector")).toBe(1);
  await app.press("id:wb-inspector-item-c-1");
  expect(app.value("id:wb-inspector-label")).toBe("锁定核心范围");
  await app.clear("id:wb-inspector-label");
  await app.type("id:wb-inspector-label", "已锁定 v1 范围");
  fake.clearCalls();
  await app.press("id:wb-inspector-save");
  await fake.pump(app);
  const writeCall = fake.calls.find((c) => c.op === "note.file.write");
  expect(writeCall).toBeDefined();

  await app.press("id:wb-chat");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(1);

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

  await app.press("id:start-farm");

  fake.clearCalls();
  await app.press("id:language-en");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "setting.update")?.payload).toMatchObject({ locale: "en" });
  expect(fake.calls.find((c) => c.op === "host.locale")?.payload).toBe("en");

  await app.press("id:settings-section-appearance");
  await fake.pumpUntil(app, () => app.count("id:theme-dark") === 1);
  await app.press("id:theme-dark");
  expect(fake.calls.find((c) => c.op === "host.theme")?.payload).toBe("dark");
});

test("settings: appearance motion control dispatches host.motion, syncs host events, and applies off mode", async () => {
  const { app, fake } = await mountApp(
    "/settings/appearance",
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
    "/settings/appearance",
    (f) => {
      f.respond("host.info", { capabilities: ["theme", "motion"], motion: "off" });
    },
    { params: { motion: "off" } },
  );
  expect(bootOff.app.viewStyle("id:motion-off")?.backgroundColor).toBeTruthy();
  expect(bootOff.app.viewStyle("id:motion-system")?.backgroundColor).toBeUndefined();
});

test("regression: whiteboard ChannelSidePane survives note polling, remount after ready, and slice updates without dropping channel.follow", async () => {
  const { app, fake, fixture } = await mountApp("/notes/art-launch-board", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
    f.respond("channel.message.list", []);
    f.respond("channel.message.send", null);
  });
  const clock = app.clock;
  if (!clock) throw new Error("whiteboard chat regression test requires a manual virtual clock");

  await fake.pumpUntil(app, () => app.count("id:wb-count") === 1 && !app.texts().includes("0 个元素"));

  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(1);
  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(0);
  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(1);

  await app.type("id:composer-input", "帮我优化一下呢？");
  await clock.fastForward(5_500);
  await fake.pump(app);
  expect(app.value("id:composer-input")).toBe("帮我优化一下呢？");

  fake.clearCalls();
  await app.press("id:send");
  await fake.pump(app);
  const sendCall = fake.calls.find((c) => c.op === "channel.message.send");
  const sendPayload = sendCall?.payload as { id?: string; text?: string; sendKey?: string; viewContext?: { noteType?: string; title?: string } } | undefined;
  expect(sendPayload).toMatchObject({
    id: "general",
    text: "帮我优化一下呢？",
    viewContext: { noteType: "canvas", title: "产品发布时间线" },
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
        viewContext: { noteId: "art-launch-board", noteType: "canvas", title: "产品发布时间线", seq: 2 },
      },
    },
    (p: unknown) => (p as { id?: string }).id === "general",
  );
  await fake.pump(app);

  expect(app.count("id:message-1")).toBe(1);
  expect(app.texts()).toContain("帮我优化一下呢？");
  expect(app.count("id:pending-line-sending")).toBe(0);
  expect(app.count("id:pending-line-failed")).toBe(0);

  fake.clearCalls();
  await app.type("id:composer-input", "第二条也发出去");
  await app.press("id:send");
  await fake.pump(app);
  const secondSend = fake.calls.find((c) => c.op === "channel.message.send")?.payload as { sendKey?: string } | undefined;
  expect(secondSend?.sendKey).toBeTruthy();

  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:note-rail")).toBe(0);

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
        viewContext: { noteId: "art-launch-board", noteType: "canvas", title: "产品发布时间线", seq: 2 },
      },
    },
    (p: unknown) => (p as { id?: string }).id === "general",
  );
  await app.press("id:note-rail-toggle");
  await fake.pump(app);
  expect(app.count("id:message-2")).toBe(1);
  expect(app.texts()).toContain("第二条也发出去");
  expect(app.count("id:pending-line-sending")).toBe(0);
  expect(app.count("id:pending-line-failed")).toBe(0);

  await clock.fastForward(21_000);
  await fake.pump(app);
  expect(app.count("id:pending-line-failed")).toBe(0);
});

test("regression: defineStored preferences persist through nsh Storage and survive app reload", async () => {
  const first = await mountApp("/settings/general", (f) => {
    f.respond("host.theme", null);
    f.respond("host.font", { monoFont: "Menlo", terminalFontSize: 14, uiFontSize: 14 });
  });

  await first.app.press("id:start-farm");
  await first.app.press("id:settings-section-appearance");
  await first.fake.pumpUntil(first.app, () => first.app.count("id:theme-dark") === 1);
  await first.app.press("id:theme-dark");
  await first.app.press("id:scale-110");
  await first.app.waitUntil(() => {
    const raw = first.app.storage()["vibevalley.prefs"];
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { theme?: string; scale?: number; start?: string };
    return parsed.theme === "dark" && parsed.scale === 110 && parsed.start === "farm";
  });

  const persisted = first.app.storage();
  expect(JSON.parse(persisted["vibevalley.prefs"] ?? "{}")).toMatchObject({
    theme: "dark",
    scale: 110,
    start: "farm",
  });

  const reloaded = await mountApp("/settings/general", undefined, { storage: persisted });
  await reloaded.app.waitUntil(() => reloaded.app.viewStyle("id:start-farm")?.backgroundColor !== undefined);
  expect(reloaded.app.viewStyle("id:start-workbench")?.backgroundColor).toBeUndefined();

  await reloaded.app.press("id:settings-section-appearance");
  await reloaded.fake.pumpUntil(reloaded.app, () => reloaded.app.count("id:theme-dark") === 1);
  await reloaded.app.waitUntil(
    () => reloaded.app.viewStyle("id:theme-dark")?.backgroundColor !== undefined && reloaded.app.viewStyle("id:scale-110")?.backgroundColor !== undefined,
  );
  expect(reloaded.app.viewStyle("id:theme-system")?.backgroundColor).toBeUndefined();

  const rootReload = await mountApp("/", undefined, { storage: persisted });
  await rootReload.fake.pumpUntil(rootReload.app, () => rootReload.fake.acts.some((a) => a.type === "openFarm"));
  expect(rootReload.fake.acts.some((a) => a.type === "openFarm")).toBe(true);
});

test("bottom-left update control: always shows release-notes dialog before restart, downloading/verifying/installing pills, and active-session warning", async () => {
  const readyApp = await mountApp("/issues", (f) => {
    f.respond("host.updateState", {
      _tag: "ready",
      version: "0.4.0",
      next: "0.4.1",
      notes: ["Faster content views", "Resumable auto-update"],
      newFarm: false,
      page: "https://github.com/vibevalleyhq/vibevalley/releases/tag/v0.4.1",
    });
    f.respond("host.updateInstall", null);
  });

  await readyApp.fake.setSlice(readyApp.app, "sessions", {
    ...readyApp.fixture.state.sessions,
    sessions: [],
  });
  await readyApp.fake.pumpUntil(readyApp.app, () => readyApp.app.count("id:rail-update-btn") === 1);
  readyApp.fake.clearCalls();
  await readyApp.app.press("id:rail-update-btn");
  await readyApp.fake.pumpUntil(readyApp.app, () => readyApp.app.count("id:rail-update-confirm-dialog") === 1);
  expect(readyApp.fake.calls.some((c) => c.op === "host.updateInstall")).toBe(false);
  expect(readyApp.app.count("id:rail-update-warning")).toBe(0);
  expect(readyApp.app.count("id:rail-update-notes")).toBe(1);
  expect(readyApp.app.texts()).toContain("v0.4.0 → v0.4.1");
  expect(readyApp.app.texts()).toContain("Faster content views");
  expect(readyApp.app.texts()).toContain("Resumable auto-update");
  await readyApp.app.press("id:rail-update-confirm-cancel");
  await readyApp.fake.pumpUntil(readyApp.app, () => readyApp.app.count("id:rail-update-confirm-dialog") === 0);
  expect(readyApp.fake.calls.some((c) => c.op === "host.updateInstall")).toBe(false);

  await readyApp.app.press("id:rail-update-btn");
  await readyApp.fake.pumpUntil(readyApp.app, () => readyApp.app.count("id:rail-update-confirm-dialog") === 1);
  await readyApp.app.press("id:rail-update-confirm-sure");
  await readyApp.fake.pumpUntil(readyApp.app, () => readyApp.fake.calls.some((c) => c.op === "host.updateInstall"));

  const downloadingApp = await mountApp("/issues", (f) => {
    f.respond("host.updateState", {
      _tag: "downloading",
      version: "0.4.0",
      next: "0.4.1",
      percent: 42,
      downloadedBytes: Math.round(42.1 * 1024 * 1024),
      totalBytes: Math.round(86.4 * 1024 * 1024),
      speedBps: Math.round(3.2 * 1024 * 1024),
    });
  });
  await downloadingApp.fake.pumpUntil(downloadingApp.app, () => downloadingApp.app.count("id:rail-update-downloading") === 1);
  expect(downloadingApp.app.count("id:rail-update-progress")).toBe(1);
  expect(downloadingApp.app.texts()).toContain("42%");

  await downloadingApp.fake.pushUpdateState(downloadingApp.app, {
    _tag: "verifying",
    version: "0.4.0",
    next: "0.4.1",
  });
  await downloadingApp.fake.pumpUntil(downloadingApp.app, () => downloadingApp.app.count("id:rail-update-verifying") === 1);

  await downloadingApp.fake.pushUpdateState(downloadingApp.app, {
    _tag: "installing",
    version: "0.4.0",
    next: "0.4.1",
  });
  await downloadingApp.fake.pumpUntil(downloadingApp.app, () => downloadingApp.app.count("id:rail-update-installing") === 1);

  const busyApp = await mountApp("/issues", (f) => {
    f.respond("host.updateState", {
      _tag: "ready",
      version: "0.4.0",
      next: "0.4.1",
      notes: ["Fix issue sync"],
      newFarm: false,
      page: "",
    });
    f.respond("host.updateInstall", null);
  });
  await busyApp.fake.pumpUntil(busyApp.app, () => busyApp.app.count("id:rail-update-btn") === 1);
  busyApp.fake.clearCalls();
  await busyApp.app.press("id:rail-update-btn");
  await busyApp.fake.pumpUntil(busyApp.app, () => busyApp.app.count("id:rail-update-confirm-dialog") === 1);
  expect(busyApp.app.count("id:rail-update-warning")).toBe(1);
  expect(busyApp.fake.calls.some((c) => c.op === "host.updateInstall")).toBe(false);
  await busyApp.app.press("id:rail-update-confirm-sure");
  await busyApp.fake.pumpUntil(busyApp.app, () => busyApp.fake.calls.some((c) => c.op === "host.updateInstall"));
});

test("content & note UX: library quick generate, history panel, and doc/base routes", async () => {
  const lib = await mountApp("/library", (f) => {
    for (const [op, handler] of Object.entries(noteResponses)) {
      f.respond(op, handler);
    }
  });
  expect(lib.app.count("id:library-source")).toBe(0);
  expect(lib.app.count("id:library-make-btn")).toBe(1);
  await lib.app.press("id:content-nav-note-doc");
  await lib.fake.pump(lib.app);
  expect(lib.app.count("id:library-make-btn")).toBe(0);
  await lib.app.press("id:content-nav-recent");
  await lib.fake.pump(lib.app);
  await lib.app.press("id:library-make-btn");
  await lib.fake.pumpUntil(lib.app, () => lib.app.count("id:library-make-dialog") === 1);

  const docNote = (noteResponses["note.list"] as { toJSON: () => Note[] }).toJSON().find((n) => n.id === "art-login");
  if (docNote) {
    const docApp = await mountApp(`/notes/${docNote.id}`, (f) => {
      for (const [op, handler] of Object.entries(noteResponses)) {
        f.respond(op, handler);
      }
    });
    await docApp.fake.pumpUntil(docApp.app, () => docApp.app.count("id:note-history-toggle") === 1);
    expect(docApp.app.count("id:note-version-badge")).toBe(1);
    const firstVersion = docNote.versions[0];
    if (firstVersion !== undefined) {
      await docApp.app.press("id:note-history-toggle");
      await docApp.fake.pumpUntil(docApp.app, () => docApp.app.count("id:note-history-panel") === 1);
      expect(docApp.app.count(`id:note-version-${firstVersion.version}`)).toBe(1);
    }
  }
});
