import { expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

import { BizCode } from "@vibevalley/protocol/api";

import { computeMobileLayout, DUAL_PANE_MIN_WIDTH } from "./src/design/layout";

const BASE = "http://127.0.0.1:8890";
const TOKEN = "vv_dev_mobile_test_token";
const NOW = 1_764_000_000_000;

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

const sampleInboxSlice = {
  seq: 1,
  call: "idle",
  callReason: "",
  items: [
    {
      id: "inbox-review-1",
      kind: "review",
      from: { kind: "session", id: "sess-1", name: "Builder Fox", agent: "builder" },
      who: "Builder Fox",
      text: "Ready for your review on mobile remote app",
      at: NOW,
      target: { kind: "issue", id: "issue-1" },
      words: {
        label: "Review",
        title: "Review #101",
        body: "Builder Fox handed back #101 for review",
        tray: "Review #101",
      },
    },
  ],
};

const sampleCollabSlice = {
  seq: 2,
  channelSummary: { unreadTotal: 2, unreadUnder: { "ch-1": 2 } },
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
        unread: 2,
        title: "general",
        subjectKind: null,
        last: {
          from: "orch",
          name: "Orchestrator",
          text: "Wave 2 build is green",
          at: NOW,
        },
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
        doing: {
          action: "run_command",
          label: "Running nsh test",
          actionText: "Running command",
        },
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
      title: "Build iOS mobile remote shell",
      description: "Implement pairing and 4 tabs over HttpRemoteTransport.",
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
    {
      id: "issue-2",
      number: 102,
      title: "Add Tailscale diagnostics",
      description: "Verify peer reachability.",
      mandate: { strength: "explicit", maxBotReviewRounds: 2, autoSubmitPr: false },
      repo: "vibevalley",
      assignments: [],
      priority: "medium",
      createdAt: NOW - 90_000,
      blockedBy: [],
      status: "in_progress",
      moves: ["in_review", "done"],
      deliver: "change",
      findings: [],
      questions: [],
      criteria: [],
      checks: [],
      stage: { state: "working", acts: [] },
    },
    {
      id: "issue-3",
      number: 103,
      title: "Ship Wave 1 protocol types",
      description: "Completed protocol contract.",
      mandate: { strength: "explicit", maxBotReviewRounds: 2, autoSubmitPr: false },
      repo: "vibevalley",
      assignments: [],
      priority: "low",
      createdAt: NOW - 300_000,
      blockedBy: [],
      status: "done",
      moves: ["todo"],
      deliver: "change",
      findings: [],
      questions: [],
      criteria: [],
      checks: [],
      stage: { state: "done", acts: [] },
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
    text: "Morning check-in from Mac",
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

const sampleFollowMessage = {
  _tag: "Message",
  message: {
    id: "msg-2",
    number: 2,
    channel: "ch-1",
    from: "orch",
    actor: { kind: "agent", id: "orch", role: "orchestrator", name: "Orchestrator" },
    name: "Orchestrator",
    kind: "chat",
    text: "Live streamed update",
    mentions: [],
    outcome: null,
    spoken: false,
    at: NOW - 5_000,
    revision: 2,
    reactions: [],
    attachments: [],
    embeds: [],
  },
};

const sampleSessionWatchEvents = [
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
      pendingPermissions: [
        {
          requestId: "perm-1",
          tool: "shell",
          summary: "Run cargo test -p vibevalley-server",
          input: "cargo test -p vibevalley-server",
        },
        {
          requestId: "perm-2",
          tool: "write_file",
          summary: "Overwrite local config",
        },
      ],
      pendingInteractions: [
        {
          requestId: "inter-1",
          question: "Should we deploy to TestFlight?",
          options: [
            { id: "opt-yes", label: "Yes, upload" },
            { id: "opt-later", label: "Later" },
          ],
          allowCustom: true,
        },
      ],
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
          output: "all 42 tests ok",
        },
      ],
    },
  },
];

function createFullNetwork(overrides: Record<string, StubResponse | ((req: StubRequest) => StubResponse)> = {}) {
  return {
    [`POST ${BASE}/api/v1/remote/pair/exchange`]: (req: StubRequest) => {
      const parsed = JSON.parse(req.body ?? "{}") as { code?: string; deviceName?: string; platform?: string };
      return okEnvelope({
        device: {
          id: "dev-1",
          name: parsed.deviceName ?? "iPhone",
          platform: parsed.platform ?? "ios",
          scope: "remote:default",
          createdAt: NOW,
        },
        token: TOKEN,
        serverName: "Lucas MacBook Pro",
        version: "0.9.0",
      });
    },
    [`GET ${BASE}/api/v1/slice/inbox`]: sseResponse([{ id: "1", data: sampleInboxSlice }]),
    [`GET ${BASE}/api/v1/slice/collab`]: sseResponse([{ id: "2", data: sampleCollabSlice }]),
    [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: sampleSessionsSlice }]),
    [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: sampleBoardSlice }]),
    [`GET ${BASE}/api/v1/subscribe/session.watch*`]: sseResponse(sampleSessionWatchEvents),
    [`POST ${BASE}/api/v1/session/respondPermission`]: okEnvelope(null),
    [`POST ${BASE}/api/v1/session/respondInteraction`]: okEnvelope(null),
    [`POST ${BASE}/api/v1/session/send`]: okEnvelope(sampleSessionWatchEvents[0].data.session),
    [`POST ${BASE}/api/v1/session/stop`]: okEnvelope(null),
    [`POST ${BASE}/api/v1/channel/message/list`]: okEnvelope(sampleChannelHistory),
    [`GET ${BASE}/api/v1/subscribe/channel.follow*`]: sseResponse([{ data: sampleFollowMessage }]),
    [`POST ${BASE}/api/v1/channel/message/send`]: okEnvelope(null),
    [`POST ${BASE}/api/v1/issue/status/update`]: okEnvelope({ ...sampleBoardSlice.issues[0], status: "done", seq: 5 }),
    [`POST ${BASE}/api/v1/issue/comment/create`]: okEnvelope({ seq: 6 }),
    [`POST ${BASE}/api/v1/issue/review`]: okEnvelope({ ...sampleBoardSlice.issues[0], reviewedAt: NOW }),
    ...overrides,
  };
}

test("manual pairing validates input, pairs via POST /api/v1/remote/pair/exchange, and switches to 4-tab home", async () => {
  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    network: createFullNetwork(),
  });

  await app.waitFor("id:pair-screen");

  await app.press("id:pair-submit");
  await app.waitFor("id:pair-error");
  expect(app.texts()).toContain("Enter a valid address, pairing code, and device name.");
  expect(app.requests()).toHaveLength(0);

  await app.type("id:pair-url-input", BASE);
  await app.type("id:pair-code-input", "PAIR42");
  await app.clear("id:pair-device-input");
  await app.type("id:pair-device-input", "Test iPhone");
  await app.press("id:pair-submit");

  await app.waitFor("id:mobile-home");
  await app.waitUntil(() => app.texts().includes("Connected"));

  expect(app.texts()).toContain("Lucas MacBook Pro");
  expect(app.texts()).toContain("Connected");

  const pairReq = app.requests().find((r) => r.url === `${BASE}/api/v1/remote/pair/exchange`);
  expect(pairReq).toBeDefined();
  expect(pairReq?.method).toBe("POST");
  expect(JSON.parse(pairReq?.body ?? "{}")).toMatchObject({
    code: "PAIR42",
    deviceName: "Test iPhone",
    platform: "other",
  });

  const saved = app.storage()["vibevalley.remote.credentials.v1"];
  expect(saved).toBeDefined();
  expect(JSON.parse(saved)).toMatchObject({
    baseUrl: BASE,
    token: TOKEN,
    serverName: "Lucas MacBook Pro",
  });
});

test("deep-link vibevalley://pair automatically pairs at launch and via openWithUrl", async () => {
  const launchUrl = `vibevalley://pair?url=${encodeURIComponent(BASE)}&code=DEEP88`;
  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    urlScheme: launchUrl,
    network: createFullNetwork(),
  });

  await app.waitFor("id:mobile-home");
  await app.waitUntil(() => app.texts().includes("Connected"));

  const pairReq = app.requests().find((r) => r.url === `${BASE}/api/v1/remote/pair/exchange`);
  expect(pairReq).toBeDefined();
  expect(JSON.parse(pairReq?.body ?? "{}")).toMatchObject({ code: "DEEP88" });

  await app.press("id:disconnect-button");
  await app.waitFor("id:pair-screen");
  expect(app.storage()["vibevalley.remote.credentials.v1"]).toBeUndefined();

  await app.openWithUrl(`vibevalley://pair?url=${encodeURIComponent(BASE)}&code=LIVE99`);
  await app.waitFor("id:mobile-home");
  const runtimeReq = app.requests().findLast((r) => r.url === `${BASE}/api/v1/remote/pair/exchange`);
  expect(JSON.parse(runtimeReq?.body ?? "{}")).toMatchObject({ code: "LIVE99" });
});

test("all 4 tabs exercise Inbox approve/deny/answer, Channels history+follow+send, Sessions watch+send+stop, and Issues filter+status+comment+review", async () => {
  const initialStorage = {
    "vibevalley.remote.credentials.v1": JSON.stringify({
      baseUrl: BASE,
      token: TOKEN,
      deviceName: "iPhone",
      serverName: "Lucas MacBook Pro",
    }),
  };

  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: initialStorage,
    network: createFullNetwork(),
  });

  await app.waitFor("id:mobile-home");
  await app.waitFor("id:inbox-permission-perm-1");
  await app.waitFor("id:inbox-interaction-inter-1");

  await app.press("id:inbox-approve-perm-1");
  await app.waitFor("id:inbox-permission-perm-1", { state: "gone" });

  await app.press("id:inbox-deny-perm-2");
  await app.waitFor("id:inbox-permission-perm-2", { state: "gone" });

  await app.press("id:inbox-option-inter-1-opt-yes");
  await app.waitFor("id:inbox-interaction-inter-1", { state: "gone" });

  const permCalls = app
    .requests()
    .filter((r) => r.url === `${BASE}/api/v1/session/respondPermission`)
    .map((r) => JSON.parse(r.body ?? "{}"));
  expect(permCalls).toEqual([
    { id: "sess-1", requestId: "perm-1", decision: "allowOnce" },
    { id: "sess-1", requestId: "perm-2", decision: "deny" },
  ]);

  const interCalls = app
    .requests()
    .filter((r) => r.url === `${BASE}/api/v1/session/respondInteraction`)
    .map((r) => JSON.parse(r.body ?? "{}"));
  expect(interCalls).toEqual([{ id: "sess-1", requestId: "inter-1", optionId: "opt-yes" }]);

  await app.press("id:tab-channels");
  await app.waitFor("id:channel-row-ch-1");
  await app.press("id:channel-row-ch-1");
  await app.waitFor("id:channel-message-msg-1");
  await app.waitFor("id:channel-message-msg-2");

  await app.type("id:channel-reply-input", "Looks great from mobile!");
  await app.press("id:channel-reply-send");
  await app.waitUntil(() => app.requests().some((r) => r.url === `${BASE}/api/v1/channel/message/send`));
  const sendMsgReq = app.requests().find((r) => r.url === `${BASE}/api/v1/channel/message/send`);
  expect(JSON.parse(sendMsgReq?.body ?? "{}")).toEqual({ id: "ch-1", text: "Looks great from mobile!" });

  await app.press("id:channel-back");
  await app.waitFor("id:channel-row-ch-1");

  await app.press("id:tab-sessions");
  await app.waitFor("id:session-row-sess-1");
  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-detail");
  await app.waitFor("id:session-event-1");
  expect(app.texts()).toContain("Trajectory");
  expect(app.texts()).toContain("Running test suite");

  await app.type("id:session-prompt-input", "Please check dark theme contrast");
  await app.press("id:session-prompt-send");
  await app.waitUntil(() => app.requests().some((r) => r.url === `${BASE}/api/v1/session/send`));
  const sessionSendReq = app.requests().find((r) => r.url === `${BASE}/api/v1/session/send`);
  expect(JSON.parse(sessionSendReq?.body ?? "{}")).toEqual({
    id: "sess-1",
    text: "Please check dark theme contrast",
  });

  await app.press("id:session-stop-button");
  await app.waitUntil(() => app.requests().some((r) => r.url === `${BASE}/api/v1/session/stop`));
  const stopReq = app.requests().find((r) => r.url === `${BASE}/api/v1/session/stop`);
  expect(JSON.parse(stopReq?.body ?? "{}")).toEqual({ id: "sess-1" });

  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-1");
  expect(app.shows("id:issue-row-issue-2")).toBe(true);
  expect(app.shows("id:issue-row-issue-3")).toBe(true);

  await app.press("id:issue-filter-review");
  expect(app.shows("id:issue-row-issue-1")).toBe(true);
  expect(app.shows("id:issue-row-issue-2")).toBe(false);
  expect(app.shows("id:issue-row-issue-3")).toBe(false);

  await app.press("id:issue-filter-done");
  expect(app.shows("id:issue-row-issue-3")).toBe(true);
  expect(app.shows("id:issue-row-issue-1")).toBe(false);

  await app.press("id:issue-filter-all");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-detail");

  await app.press("id:issue-move-done");
  await app.waitUntil(() => app.requests().some((r) => r.url === `${BASE}/api/v1/issue/status/update`));
  const moveReq = app.requests().find((r) => r.url === `${BASE}/api/v1/issue/status/update`);
  expect(JSON.parse(moveReq?.body ?? "{}")).toEqual({ id: "issue-1", status: "done" });

  await app.type("id:issue-comment-input", "Ship it!");
  await app.press("id:issue-comment-send");
  await app.waitUntil(() => app.requests().some((r) => r.url === `${BASE}/api/v1/issue/comment/create`));
  const commentReq = app.requests().find((r) => r.url === `${BASE}/api/v1/issue/comment/create`);
  expect(JSON.parse(commentReq?.body ?? "{}")).toEqual({ id: "issue-1", text: "Ship it!" });

  await app.press("id:issue-review-approve");
  await app.waitUntil(() => app.requests().some((r) => r.url === `${BASE}/api/v1/issue/review`));
  const approveReq = app.requests().find((r) => r.url === `${BASE}/api/v1/issue/review`);
  expect(JSON.parse(approveReq?.body ?? "{}")).toEqual({ id: "issue-1", pass: true });

  await app.press("id:issue-review-changes");
  await app.waitUntil(() => app.requests().filter((r) => r.url === `${BASE}/api/v1/issue/review`).length === 2);
  const changesReq = app.requests().findLast((r) => r.url === `${BASE}/api/v1/issue/review`);
  expect(JSON.parse(changesReq?.body ?? "{}")).toEqual({ id: "issue-1", pass: false });
});

test("iOS platform defaults device name to iPhone, sends platform ios, and renders native TabBar", async () => {
  const app = await open("./App.story.tsx", {
    platform: "ios",
    locale: "en-US",
    width: 390,
    height: 844,
    network: createFullNetwork(),
  });

  await app.waitFor("id:pair-screen");
  expect(app.value("id:pair-device-input")).toBe("iPhone");

  await app.type("id:pair-url-input", BASE);
  await app.type("id:pair-code-input", "IOS777");
  await app.press("id:pair-submit");

  await app.waitFor("id:mobile-home");
  await app.waitUntil(() => app.texts().includes("Connected"));

  const pairReq = app.requests().find((r) => r.url === `${BASE}/api/v1/remote/pair/exchange`);
  expect(JSON.parse(pairReq?.body ?? "{}")).toMatchObject({
    code: "IOS777",
    deviceName: "iPhone",
    platform: "ios",
  });
  expect(app.shows("id:mobile-home")).toBe(true);
  expect(app.count("id:mobile-tabbar")).toBe(0);
});

test("connection state reflects unauthorized 401 and supports tapping Inbox review item to jump to Issue detail", async () => {
  const initialStorage = {
    "vibevalley.remote.credentials.v1": JSON.stringify({
      baseUrl: BASE,
      token: TOKEN,
      deviceName: "iPhone",
      serverName: "Lucas MacBook Pro",
    }),
  };

  const revokedApp = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: initialStorage,
    network: {
      [`GET ${BASE}/api/v1/slice/*`]: {
        status: 401,
        headers: { "content-type": "application/json" },
        body: { bizCode: BizCode.Unauthorized, message: "revoked" },
      },
    },
  });

  await revokedApp.waitFor("id:mobile-home");
  await revokedApp.waitUntil(() => revokedApp.texts().includes("Access revoked or expired. Pair again."));
  expect(revokedApp.texts()).toContain("Access revoked or expired. Pair again.");

  const navApp = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: initialStorage,
    network: createFullNetwork(),
  });

  await navApp.waitFor("id:inbox-item-inbox-review-1");
  await navApp.press("id:inbox-item-inbox-review-1");
  await navApp.waitFor("id:issue-detail");
  expect(navApp.texts()).toContain("#101 Build iOS mobile remote shell");
});

test("computeMobileLayout classifies compact phones, Pixel Fold cover/unfolded, and iPhone Duo / iPad mini accurately", () => {
  expect(DUAL_PANE_MIN_WIDTH).toBe(600);

  const compactIphone = computeMobileLayout({ width: 393, height: 852 }, { top: 59, right: 0, bottom: 34, left: 0 });
  expect(compactIphone).toEqual({
    mode: "compact",
    masterWidth: 393,
    isLandscape: false,
    safe: { top: 59, right: 0, bottom: 34, left: 0 },
  });

  const pixelFoldCover = computeMobileLayout({ width: 384, height: 832 }, { top: 44, right: 0, bottom: 24, left: 0 });
  expect(pixelFoldCover.mode).toBe("compact");
  expect(pixelFoldCover.isLandscape).toBe(false);
  expect(pixelFoldCover.masterWidth).toBe(384);

  const pixelFoldUnfolded = computeMobileLayout({ width: 841, height: 701 }, { top: 24, right: 16, bottom: 24, left: 16 });
  expect(pixelFoldUnfolded.mode).toBe("dual_pane");
  expect(pixelFoldUnfolded.isLandscape).toBe(true);
  expect(pixelFoldUnfolded.masterWidth).toBe(320);

  const iphoneDuo = computeMobileLayout({ width: 744, height: 1133 }, { top: 24, right: 0, bottom: 20, left: 0 });
  expect(iphoneDuo.mode).toBe("dual_pane");
  expect(iphoneDuo.isLandscape).toBe(false);
  expect(iphoneDuo.masterWidth).toBe(283);

  const wideClamp = computeMobileLayout({ width: 1200, height: 800 }, { top: 20, right: 0, bottom: 20, left: 0 });
  expect(wideClamp.mode).toBe("dual_pane");
  expect(wideClamp.masterWidth).toBe(360);

  const threshold = computeMobileLayout({ width: 600, height: 800 }, { top: 0, right: 0, bottom: 0, left: 0 });
  expect(threshold.mode).toBe("dual_pane");
  expect(threshold.masterWidth).toBe(280);
});

test("Pixel Fold unfolded (840x700 Android) renders centered PairScreen, Left Navigation Rail, and simultaneous master-detail across all 4 tabs", async () => {
  const app = await open("./App.story.tsx", {
    platform: "android",
    locale: "en-US",
    width: 840,
    height: 700,
    safeArea: { top: 24, bottom: 24, left: 12, right: 12 },
    network: createFullNetwork(),
  });

  await app.waitFor("id:pair-screen");
  expect(app.shows("id:pair-card-container")).toBe(true);
  expect(app.value("id:pair-device-input")).toBe("Android");

  await app.type("id:pair-url-input", BASE);
  await app.type("id:pair-code-input", "FOLD35");
  await app.press("id:pair-submit");

  await app.waitFor("id:mobile-home");
  await app.waitFor("id:mobile-nav-rail");
  await app.waitUntil(() => app.texts().includes("Connected"));

  const pairReq = app.requests().find((r) => r.url === `${BASE}/api/v1/remote/pair/exchange`);
  expect(JSON.parse(pairReq?.body ?? "{}")).toMatchObject({
    code: "FOLD35",
    deviceName: "Android",
    platform: "android",
  });
  expect(app.count("id:mobile-tabbar")).toBe(0);

  await app.waitFor("id:inbox-row-perm:sess-1:perm-1");
  expect(app.shows("id:mobile-master-pane")).toBe(true);
  expect(app.shows("id:mobile-detail-pane")).toBe(true);
  await app.waitFor("id:inbox-permission-perm-1");
  await app.press("id:inbox-approve-perm-1");
  await app.waitFor("id:inbox-permission-perm-2");

  await app.press("id:inbox-row-item:inbox-review-1");
  await app.waitFor("id:inbox-jump-inbox-review-1");
  await app.press("id:inbox-jump-inbox-review-1");
  await app.waitFor("id:issues-tab");
  expect(app.shows("id:mobile-master-pane")).toBe(true);
  expect(app.shows("id:mobile-detail-pane")).toBe(true);
  expect(app.shows("id:issue-filter-bar")).toBe(true);
  expect(app.texts()).toContain("#101 Build iOS mobile remote shell");

  await app.press("id:tab-channels");
  await app.waitFor("id:channel-row-ch-1");
  await app.waitFor("id:channel-detail");
  await app.waitFor("id:channel-message-msg-1");
  expect(app.shows("id:mobile-master-pane")).toBe(true);
  expect(app.shows("id:mobile-detail-pane")).toBe(true);

  await app.press("id:tab-sessions");
  await app.waitFor("id:session-row-sess-1");
  await app.waitFor("id:session-detail");
  await app.waitFor("id:session-event-1");
  expect(app.shows("id:mobile-master-pane")).toBe(true);
  expect(app.shows("id:mobile-detail-pane")).toBe(true);
});

test("iPhone Duo (744x1024) fold/unfold preserves active detail selection and compact Android BackHandler exits detail cleanly", async () => {
  const initialStorage = {
    "vibevalley.remote.credentials.v1": JSON.stringify({
      baseUrl: BASE,
      token: TOKEN,
      deviceName: "iPhone",
      serverName: "Lucas MacBook Pro",
    }),
  };

  const app = await open("./App.story.tsx", {
    platform: "ios",
    locale: "en-US",
    width: 744,
    height: 1024,
    safeArea: { top: 24, bottom: 20, left: 0, right: 0 },
    storage: initialStorage,
    network: createFullNetwork(),
  });

  await app.waitFor("id:mobile-nav-rail");
  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-2");
  await app.press("id:issue-row-issue-2");
  await app.waitUntil(() => app.texts().includes("#102 Add Tailscale diagnostics"));

  await app.setViewport(393, 852);
  await app.waitFor("id:issue-back");
  expect(app.count("id:mobile-nav-rail")).toBe(0);
  expect(app.shows("id:mobile-detail-pane")).toBe(true);
  expect(app.texts()).toContain("#102 Add Tailscale diagnostics");

  await app.setViewport(840, 700);
  await app.waitFor("id:mobile-nav-rail");
  expect(app.shows("id:mobile-master-pane")).toBe(true);
  expect(app.shows("id:mobile-detail-pane")).toBe(true);
  expect(app.count("id:issue-back")).toBe(0);
  expect(app.texts()).toContain("#102 Add Tailscale diagnostics");

  const androidCover = await open("./App.story.tsx", {
    platform: "android",
    locale: "en-US",
    width: 384,
    height: 832,
    storage: initialStorage,
    network: createFullNetwork(),
  });

  await androidCover.waitFor("id:inbox-item-inbox-review-1");
  await androidCover.press("id:inbox-item-inbox-review-1");
  await androidCover.waitFor("id:issue-detail");
  await androidCover.waitFor("id:issue-back");
  await androidCover.back();
  await androidCover.waitFor("id:issue-row-issue-1");
  expect(androidCover.count("id:issue-detail")).toBe(0);

  await androidCover.press("id:issue-row-issue-1");
  await androidCover.waitFor("id:issue-detail");
  await androidCover.press("id:issue-back");
  await androidCover.waitFor("id:issue-row-issue-1");
  expect(androidCover.count("id:issue-detail")).toBe(0);
});
