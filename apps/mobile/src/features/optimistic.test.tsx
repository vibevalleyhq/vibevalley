import { expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

import { BizCode } from "@vibevalley/protocol/api";

import { PROFILE_STORAGE_KEY, TEST_HARNESS_TOKEN_KEY } from "../infra/storage";

const BASE = "http://127.0.0.1:8890";
const TOKEN = "vv_dev_mobile_optimistic_token";
const NOW = 1_764_000_000_000;

function harnessStorage(): Record<string, string> {
  return {
    [PROFILE_STORAGE_KEY]: JSON.stringify({
      baseUrl: BASE,
      deviceName: "iPhone",
      serverName: "Lucas MacBook Pro",
    }),
    [TEST_HARNESS_TOKEN_KEY]: TOKEN,
  };
}

function sseResponse(events: readonly { readonly id?: string; readonly data: unknown }[], holdOpen = true): StubResponse {
  const body = events.map((ev) => `${ev.id !== undefined ? `id: ${ev.id}\n` : ""}data: ${JSON.stringify(ev.data)}\n\n`).join("");
  return {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...(holdOpen ? { "x-test-hold-open": "1" } : {}),
    },
    body,
  };
}

function okEnvelope(data: unknown): StubResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { bizCode: 0, message: "ok", data },
  };
}

function errEnvelope(message: string): StubResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { bizCode: BizCode.InternalError, message },
  };
}

const sampleInboxSlice = {
  seq: 1,
  call: "idle",
  callReason: "",
  items: [],
};

const sampleCollabSlice = {
  seq: 2,
  channelSummary: { unreadTotal: 0, unreadUnder: {} },
  connectors: [],
  chat: {
    userMentions: [],
    channels: [
      {
        id: "ch-1",
        type: "channel",
        default: true,
        category: "",
        notify: "all",
        name: "general",
        description: "Main team channel",
        replies: 1,
        title: "general",
        subjectKind: null,
        at: NOW,
      },
    ],
  },
};

const sampleSessionsSlice = {
  seq: 3,
  machines: [],
  sessions: [
    {
      id: "sess-1",
      controller: "issueBoard",
      role: "worker",
      name: "Builder Fox",
      runtime: "codex",
      brief: "Ship mobile remote app",
      policy: { kind: "sandboxDir" },
      bindings: [],
      hiredAt: NOW - 60_000,
      runs: 1,
      phase: {
        _tag: "working",
        since: NOW - 30_000,
        doing: { action: "run_command", label: "Running nsh test", actionText: "Running command" },
      },
      phaseText: "Working",
    },
  ],
};

const sampleBoardSlice = {
  seq: 4,
  issues: [
    {
      id: "issue-1",
      number: 101,
      title: "Optimistic mobile UX",
      description: "Test optimistic comment rollback.",
      mandate: { strength: "explicit", maxBotReviewRounds: 2, autoSubmitPr: false },
      repo: "vibevalley",
      assignments: [],
      priority: "high",
      createdAt: NOW - 120_000,
      blockedBy: [],
      status: "in_review",
      moves: ["todo", "done"],
      deliver: "change",
      findings: [],
      questions: [],
      criteria: [],
      checks: [],
      stage: { state: "reviewing", acts: [] },
    },
  ],
};

const sampleChannelHistory = [
  {
    id: "msg-1",
    number: 1,
    channel: "ch-1",
    from: "orch",
    actor: { kind: "agent", id: "orch", role: "orchestrator", name: "Orchestrator" },
    name: "Orchestrator",
    kind: "chat",
    text: "Morning check-in",
    mentions: [],
    outcome: null,
    spoken: false,
    at: NOW - 20_000,
    revision: 1,
    reactions: [],
    attachments: [],
    embeds: [],
  },
];

const sampleSessionWatchInitial = [
  {
    data: {
      kind: "state",
      session: {
        id: "sess-1",
        controller: "issueBoard",
        role: "worker",
        name: "Builder Fox",
        runtime: "codex",
        brief: "Ship mobile remote app",
        policy: { kind: "sandboxDir" },
        bindings: [],
        hiredAt: NOW - 60_000,
        runs: 1,
        phase: {
          _tag: "working",
          since: NOW - 30_000,
          doing: { action: "run_command", label: "Running nsh test" },
        },
      },
      permissionMode: "ask",
      pendingPermissions: [],
      pendingInteractions: [],
    },
  },
  {
    data: {
      kind: "history",
      session: "sess-1",
      events: [
        {
          seq: 1,
          revision: 1,
          time: NOW - 10_000,
          type: "tool/call",
          tool: "shell",
          text: "Running test suite",
          output: "ok",
        },
      ],
    },
  },
];

test("ChannelsTab performs optimistic send, reuses sendKey on retry after rollback, and deduplicates on channel.follow", async () => {
  let sendAttempts = 0;
  let capturedSendKey = "";
  let followCalls = 0;

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
      [`POST ${BASE}/api/v1/channel/message/list`]: okEnvelope(sampleChannelHistory),
      [`GET ${BASE}/api/v1/subscribe/channel.follow*`]: () => {
        followCalls++;
        if (followCalls === 1) return sseResponse([]);
        if (followCalls === 2) {
          return sseResponse([
            {
              data: {
                _tag: "Message",
                message: {
                  ...sampleChannelHistory[0],
                  id: "msg-2",
                  number: 2,
                  from: "user",
                  actor: { kind: "user", id: "user", name: "iPhone" },
                  name: "iPhone",
                  text: "Optimistic hello",
                  sendKey: capturedSendKey,
                  revision: 2,
                },
              },
            },
          ]);
        }
        return sseResponse([
          {
            data: {
              _tag: "Message",
              message: {
                ...sampleChannelHistory[0],
                id: "msg-3",
                number: 3,
                from: "user",
                actor: { kind: "user", id: "user", name: "iPhone" },
                name: "iPhone",
                text: "Text-matched hello",
                revision: 3,
              },
            },
          },
        ]);
      },
      [`POST ${BASE}/api/v1/channel/message/send`]: (req: StubRequest) => {
        sendAttempts++;
        const parsed = JSON.parse(req.body ?? "{}") as { sendKey?: string };
        if (sendAttempts === 1) {
          capturedSendKey = parsed.sendKey ?? "";
          return errEnvelope("channel send failed");
        }
        return okEnvelope(null);
      },
    },
  });

  await app.press("id:tab-channels");
  await app.waitFor("id:channel-row-ch-1");
  await app.press("id:channel-row-ch-1");
  await app.waitFor("id:channel-message-msg-1");

  // 1. Failed send rolls back optimistic item and restores draft when input is empty.
  await app.type("id:channel-reply-input", "Optimistic hello");
  await app.press("id:channel-reply-send");
  await app.waitFor("id:channel-error");
  expect(app.texts()).toContain("channel send failed");
  expect(app.value("id:channel-reply-input")).toBe("Optimistic hello");
  expect(capturedSendKey.length).toBeGreaterThan(0);
  expect(app.count(`id:channel-message-pending:${capturedSendKey}`)).toBe(0);

  // 2. Retrying reuses the exact same sendKey, clears draft, and shows optimistic message.
  await app.press("id:channel-reply-send");
  await app.waitFor(`id:channel-message-pending:${capturedSendKey}`);
  expect(app.value("id:channel-reply-input")).toBe("");
  const channelReqs = app.requests().filter((r) => r.url === `${BASE}/api/v1/channel/message/send`);
  expect(channelReqs).toHaveLength(2);
  expect(JSON.parse(channelReqs[1]?.body ?? "{}")).toMatchObject({
    id: "ch-1",
    text: "Optimistic hello",
    sendKey: capturedSendKey,
  });

  // 3. Reconnecting channel.follow delivers canonical message with matching sendKey and deduplicates pending item.
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitFor("id:channel-message-msg-2");
  expect(app.count(`id:channel-message-pending:${capturedSendKey}`)).toBe(0);
  expect(app.texts().filter((txt) => txt === "Optimistic hello")).toHaveLength(1);

  // 4. Sending another message deduplicates even when channel.follow echoes matching text without sendKey.
  await app.type("id:channel-reply-input", "Text-matched hello");
  await app.press("id:channel-reply-send");
  await app.waitUntil(() => app.requests().filter((r) => r.url === `${BASE}/api/v1/channel/message/send`).length === 3);
  const thirdBody = JSON.parse(app.requests().filter((r) => r.url === `${BASE}/api/v1/channel/message/send`)[2]?.body ?? "{}") as { sendKey?: string };
  expect(thirdBody.sendKey).not.toBe(capturedSendKey);
  await app.waitFor(`id:channel-message-pending:${thirdBody.sendKey ?? ""}`);

  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitFor("id:channel-message-msg-3");
  expect(app.count(`id:channel-message-pending:${thirdBody.sendKey ?? ""}`)).toBe(0);
  expect(app.texts().filter((txt) => txt === "Text-matched hello")).toHaveLength(1);
});

test("SessionsTab appends optimistic user/message, rolls back on error, and deduplicates on session.watch", async () => {
  let sendAttempts = 0;
  let watchCalls = 0;

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
      [`GET ${BASE}/api/v1/subscribe/session.watch*`]: () => {
        watchCalls++;
        if (watchCalls === 1) return sseResponse(sampleSessionWatchInitial);
        return sseResponse([
          ...sampleSessionWatchInitial,
          {
            data: {
              kind: "event",
              session: "sess-1",
              event: {
                seq: 2,
                revision: 1,
                time: NOW,
                type: "user/message",
                text: "Run mobile checks",
              },
            },
          },
        ]);
      },
      [`POST ${BASE}/api/v1/session/send`]: () => {
        sendAttempts++;
        if (sendAttempts === 1) return errEnvelope("session send failed");
        return okEnvelope(sampleSessionWatchInitial[0].data.session);
      },
    },
  });

  await app.press("id:tab-sessions");
  await app.waitFor("id:session-row-sess-1");
  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-event-1");

  // 1. Failed send rolls back optimistic user/message and restores promptDraft.
  await app.type("id:session-prompt-input", "Run mobile checks");
  await app.press("id:session-prompt-send");
  await app.waitFor("id:session-error");
  expect(app.texts()).toContain("session send failed");
  expect(app.value("id:session-prompt-input")).toBe("Run mobile checks");
  expect(app.count("id:session-event--1")).toBe(0);

  // 2. Retry succeeds, clears draft, and renders optimistic user/message step (#-2).
  await app.press("id:session-prompt-send");
  await app.waitFor("id:session-event--2");
  expect(app.value("id:session-prompt-input")).toBe("");
  expect(app.texts()).toContain("Run mobile checks");

  // 3. Live session.watch delivers canonical seq 2 user/message and deduplicates optimistic step.
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitFor("id:session-event-2");
  expect(app.count("id:session-event--2")).toBe(0);
  expect(app.texts().filter((txt) => txt === "Run mobile checks")).toHaveLength(1);
});

test("IssuesTab submitComment clears draft optimistically and restores on RPC error", async () => {
  let commentAttempts = 0;

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
      [`POST ${BASE}/api/v1/issue/comment/create`]: () => {
        commentAttempts++;
        if (commentAttempts === 1) return errEnvelope("comment failed");
        return okEnvelope({ seq: 6 });
      },
    },
  });

  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-1");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-detail");

  await app.type("id:issue-comment-input", "Needs one more pass");
  await app.press("id:issue-comment-send");
  await app.waitFor("id:issue-error");
  expect(app.texts()).toContain("comment failed");
  expect(app.value("id:issue-comment-input")).toBe("Needs one more pass");

  await app.press("id:issue-comment-send");
  await app.waitUntil(() => app.requests().filter((r) => r.url === `${BASE}/api/v1/issue/comment/create`).length === 2);
  expect(app.value("id:issue-comment-input")).toBe("");
});

test("memoized selectors keep send buttons disabled until non-whitespace draft is entered and update issue filters cleanly", async () => {
  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
      [`POST ${BASE}/api/v1/channel/message/list`]: okEnvelope(sampleChannelHistory),
      [`GET ${BASE}/api/v1/subscribe/channel.follow*`]: sseResponse([]),
      [`GET ${BASE}/api/v1/subscribe/session.watch*`]: sseResponse(sampleSessionWatchInitial),
    },
  });

  await app.press("id:tab-channels");
  await app.waitFor("id:channel-row-ch-1");
  await app.press("id:channel-row-ch-1");
  await app.waitFor("id:channel-reply-send");
  expect(app.enabled("id:channel-reply-send")).toBe(false);
  await app.type("id:channel-reply-input", "   ");
  expect(app.enabled("id:channel-reply-send")).toBe(false);
  await app.type("id:channel-reply-input", "hi");
  expect(app.enabled("id:channel-reply-send")).toBe(true);

  await app.press("id:tab-sessions");
  await app.waitFor("id:session-row-sess-1");
  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-prompt-send");
  expect(app.enabled("id:session-prompt-send")).toBe(false);
  await app.type("id:session-prompt-input", "step");
  expect(app.enabled("id:session-prompt-send")).toBe(true);

  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-1");
  await app.press("id:issue-filter-done");
  expect(app.shows("id:issues-empty")).toBe(true);
  await app.press("id:issue-filter-review");
  await app.waitFor("id:issue-row-issue-1");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-comment-send");
  expect(app.enabled("id:issue-comment-send")).toBe(false);
  await app.type("id:issue-comment-input", "LGTM");
  expect(app.enabled("id:issue-comment-send")).toBe(true);
});

test("SessionsTab isolates confirmedSeqKeys and promptDraft per session", async () => {
  const twoSessionsSlice = {
    seq: 3,
    machines: [],
    sessions: [
      sampleSessionsSlice.sessions[0],
      {
        ...sampleSessionsSlice.sessions[0],
        id: "sess-2",
        name: "Verifier Owl",
      },
    ],
  };

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: twoSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
      [`GET ${BASE}/api/v1/subscribe/session.watch*`]: (req: StubRequest) => {
        if (req.url.includes("sess-2")) {
          return sseResponse([
            {
              data: {
                kind: "state",
                session: twoSessionsSlice.sessions[1],
                permissionMode: "ask",
                pendingPermissions: [],
                pendingInteractions: [],
              },
            },
            {
              data: {
                kind: "history",
                session: "sess-2",
                events: [
                  {
                    seq: 2,
                    revision: 1,
                    time: NOW,
                    type: "assistant/message",
                    text: "Second session event",
                  },
                ],
              },
            },
          ]);
        }
        return sseResponse([
          ...sampleSessionWatchInitial,
          {
            data: {
              kind: "event",
              session: "sess-1",
              event: {
                seq: 2,
                revision: 1,
                time: NOW,
                type: "assistant/message",
                text: "First session event",
              },
            },
          },
        ]);
      },
    },
  });

  await app.press("id:tab-sessions");
  await app.waitFor("id:session-row-sess-1");
  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-event-2");
  expect(app.texts()).toContain("First session event");

  await app.type("id:session-prompt-input", "Draft for one");
  await app.press("id:session-back");
  await app.waitFor("id:session-row-sess-2");
  await app.press("id:session-row-sess-2");
  await app.waitFor("id:session-event-2");
  expect(app.texts()).toContain("Second session event");
  expect(app.value("id:session-prompt-input")).toBe("");

  await app.type("id:session-prompt-input", "Draft for two");
  await app.press("id:session-back");
  await app.waitFor("id:session-row-sess-1");
  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-event-2");
  expect(app.value("id:session-prompt-input")).toBe("Draft for one");
});

test("IssuesTab isolates commentDraft per issue and surfaces review errors", async () => {
  const twoIssuesBoard = {
    seq: 4,
    issues: [
      sampleBoardSlice.issues[0],
      {
        ...sampleBoardSlice.issues[0],
        id: "issue-2",
        number: 102,
        title: "Second reviewable issue",
      },
    ],
  };

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: twoIssuesBoard }]),
      [`POST ${BASE}/api/v1/issue/review`]: () => errEnvelope("review rejected"),
    },
  });

  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-1");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-comment-input");
  await app.type("id:issue-comment-input", "Note on one");

  await app.press("id:issue-back");
  await app.waitFor("id:issue-row-issue-2");
  await app.press("id:issue-row-issue-2");
  await app.waitFor("id:issue-review-changes");
  expect(app.value("id:issue-comment-input")).toBe("");

  await app.press("id:issue-review-changes");
  await app.waitFor("id:issue-error");
  expect(app.texts()).toContain("review rejected");

  await app.press("id:issue-back");
  await app.waitFor("id:issue-row-issue-1");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-comment-input");
  expect(app.value("id:issue-comment-input")).toBe("Note on one");
});

test("ChannelsTab switches channels cleanly in dual-pane and updates rendered messages", async () => {
  const twoChannelsCollab = {
    ...sampleCollabSlice,
    chat: {
      ...sampleCollabSlice.chat,
      channels: [
        sampleCollabSlice.chat.channels[0],
        {
          ...sampleCollabSlice.chat.channels[0],
          id: "ch-2",
          default: false,
          name: "mobile",
          title: "mobile",
        },
      ],
    },
  };

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 900,
    height: 700,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: twoChannelsCollab }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
      [`POST ${BASE}/api/v1/channel/message/list`]: (req: StubRequest) => {
        const parsed = JSON.parse(req.body ?? "{}") as { id?: string };
        if (parsed.id === "ch-2") {
          return okEnvelope([
            {
              ...sampleChannelHistory[0],
              id: "msg-ch2",
              channel: "ch-2",
              text: "Mobile channel message",
            },
          ]);
        }
        return okEnvelope(sampleChannelHistory);
      },
      [`GET ${BASE}/api/v1/subscribe/channel.follow*`]: sseResponse([]),
    },
  });

  await app.press("id:tab-channels");
  await app.waitFor("id:channel-message-msg-1");
  expect(app.texts()).toContain("Morning check-in");

  await app.press("id:channel-row-ch-2");
  await app.waitFor("id:channel-message-msg-ch2");
  expect(app.texts()).toContain("Mobile channel message");
  expect(app.count("id:channel-message-msg-1")).toBe(0);
});

test("IssuesTab renders only server-provided moves and omits quick transitions when moves is empty", async () => {
  const board = {
    seq: 5,
    issues: [
      sampleBoardSlice.issues[0],
      {
        ...sampleBoardSlice.issues[0],
        id: "issue-no-moves",
        number: 103,
        title: "Locked status issue",
        moves: [],
      },
    ],
  };

  const app = await open("../../App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessStorage(),
    network: {
      [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
      [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "5", data: board }]),
    },
  });

  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-1");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-move-todo");
  expect(app.count("id:issue-move-todo")).toBe(1);
  expect(app.count("id:issue-move-done")).toBe(1);
  expect(app.count("id:issue-move-in_progress")).toBe(0);

  await app.press("id:issue-back");
  await app.waitFor("id:issue-row-issue-no-moves");
  await app.press("id:issue-row-issue-no-moves");
  await app.waitFor("id:issue-detail-status");
  expect(app.count("id:issue-move-todo")).toBe(0);
  expect(app.count("id:issue-move-in_progress")).toBe(0);
  expect(app.count("id:issue-move-in_review")).toBe(0);
  expect(app.count("id:issue-move-done")).toBe(0);
});
