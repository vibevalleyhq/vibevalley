import { expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

import { BizCode } from "@vibevalley/protocol/api";
import { InboxItem as InboxItemSchema } from "@vibevalley/protocol/schema";

import { computeMobileLayout, DUAL_PANE_MIN_WIDTH, NAV_RAIL_WIDTH } from "./src/design/layout";
import {
  decodeNotificationRoute,
  encodeInboxNotificationId,
  encodeInteractionNotificationId,
  encodePermissionNotificationId,
  isHighPriorityInboxKind,
} from "./src/infra/notifications";
import {
  clearCredentials,
  loadCredentials,
  PROFILE_STORAGE_KEY,
  saveCredentials,
  TEST_HARNESS_TOKEN_KEY,
  TOKEN_ACCOUNT_KEY,
  type SecureTokenStore,
} from "./src/infra/storage";

const BASE = "http://127.0.0.1:8890";
const TOKEN = "vv_dev_mobile_test_token";
const NOW = 1_764_000_000_000;

function harnessCredentialsStorage(deviceName = "iPhone"): Record<string, string> {
  return {
    [PROFILE_STORAGE_KEY]: JSON.stringify({
      baseUrl: BASE,
      deviceName,
      serverName: "Lucas MacBook Pro",
    }),
    [TEST_HARNESS_TOKEN_KEY]: TOKEN,
  };
}

function profileOnlyStorage(deviceName = "iPhone"): Record<string, string> {
  return {
    [PROFILE_STORAGE_KEY]: JSON.stringify({
      baseUrl: BASE,
      deviceName,
      serverName: "Lucas MacBook Pro",
    }),
  };
}

function createHostKeychainStub(initialToken?: string) {
  const vault = new Map<string, string>();
  if (initialToken !== undefined) vault.set(TOKEN_ACCOUNT_KEY, initialToken);
  return {
    vault,
    host: {
      handlers: {
        "keychain.get": (data: unknown) => {
          const account = (data as { account?: string } | null)?.account ?? "";
          return vault.get(account) ?? null;
        },
        "keychain.set": (data: unknown) => {
          const entry = data as { account?: string; token?: string } | null;
          if (entry?.account && entry.token) vault.set(entry.account, entry.token);
          return null;
        },
        "keychain.delete": (data: unknown) => {
          const account = (data as { account?: string } | null)?.account ?? "";
          vault.delete(account);
          return null;
        },
      },
    },
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

  const savedProfile = app.storage()[PROFILE_STORAGE_KEY];
  expect(savedProfile).toBeDefined();
  const parsedProfile = JSON.parse(savedProfile);
  expect(parsedProfile).toEqual({
    baseUrl: BASE,
    deviceName: "Test iPhone",
    serverName: "Lucas MacBook Pro",
  });
  expect(parsedProfile.token).toBeUndefined();
  expect(app.storage()[TEST_HARNESS_TOKEN_KEY]).toBe(TOKEN);
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
  expect(app.storage()[PROFILE_STORAGE_KEY]).toBeUndefined();
  expect(app.storage()[TEST_HARNESS_TOKEN_KEY]).toBeUndefined();

  await app.openWithUrl(`vibevalley://pair?url=${encodeURIComponent(BASE)}&code=LIVE99`);
  await app.waitFor("id:mobile-home");
  const runtimeReq = app.requests().findLast((r) => r.url === `${BASE}/api/v1/remote/pair/exchange`);
  expect(JSON.parse(runtimeReq?.body ?? "{}")).toMatchObject({ code: "LIVE99" });
});

test("all 4 tabs exercise Inbox approve/deny/answer, Channels history+follow+send, Sessions watch+send+stop, and Issues filter+status+comment+review", async () => {
  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessCredentialsStorage("iPhone"),
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
  const sendMsgBody = JSON.parse(sendMsgReq?.body ?? "{}") as { id?: string; text?: string; sendKey?: string };
  expect(sendMsgBody).toMatchObject({ id: "ch-1", text: "Looks great from mobile!" });
  expect(typeof sendMsgBody.sendKey).toBe("string");
  expect((sendMsgBody.sendKey ?? "").length).toBeGreaterThan(0);

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
  const initialStorage = harnessCredentialsStorage("iPhone");

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
  expect(NAV_RAIL_WIDTH).toBe(80);

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
  const iosKeychain = createHostKeychainStub(TOKEN);
  const app = await open("./App.story.tsx", {
    platform: "ios",
    locale: "en-US",
    width: 744,
    height: 1024,
    safeArea: { top: 24, bottom: 20, left: 0, right: 0 },
    storage: profileOnlyStorage("iPhone"),
    host: iosKeychain.host,
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

  const androidKeychain = createHostKeychainStub(TOKEN);
  const androidCover = await open("./App.story.tsx", {
    platform: "android",
    locale: "en-US",
    width: 384,
    height: 832,
    storage: profileOnlyStorage("Android"),
    host: androidKeychain.host,
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

test("lifecycle background suspends SSE cleanly and foreground/wake immediately resyncs with Last-Event-ID", async () => {
  let inboxCalls = 0;
  const updatedInbox = {
    ...sampleInboxSlice,
    seq: 5,
    items: [
      ...sampleInboxSlice.items,
      {
        id: "inbox-ask-2",
        kind: "ask",
        from: { kind: "session", id: "sess-1", name: "Builder Fox", agent: "builder" },
        who: "Builder Fox",
        text: "Approve release tag?",
        at: NOW + 1000,
        target: { kind: "session", id: "sess-1" },
        words: {
          label: "Question",
          title: "Release confirmation",
          body: "Ready to tag **v0.9.1**?",
          tray: "Release confirmation",
        },
      },
    ],
  };

  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessCredentialsStorage("iPhone"),
    network: createFullNetwork({
      [`GET ${BASE}/api/v1/slice/inbox`]: () => {
        inboxCalls++;
        return inboxCalls === 1 ? sseResponse([{ id: "1", data: sampleInboxSlice }]) : sseResponse([{ id: "5", data: updatedInbox }]);
      },
    }),
  });

  await app.waitFor("id:inbox-item-inbox-review-1");
  await app.waitUntil(() => app.texts().includes("Connected"));
  expect(inboxCalls).toBe(1);

  await app.setLifecycle("background");
  expect(app.texts()).not.toContain("Connection lost, reconnecting…");

  await app.setLifecycle("inactive");
  expect(inboxCalls).toBe(1);

  await app.setLifecycle("active");
  await app.waitFor("id:inbox-item-inbox-ask-2");
  expect(inboxCalls).toBe(2);

  const inboxReqs = app.requests().filter((r) => r.url === `${BASE}/api/v1/slice/inbox`);
  expect(inboxReqs[1]?.headers["last-event-id"]).toBe("1");

  await app.wake();
  await app.waitUntil(() => inboxCalls >= 3);
  const wakeInboxReqs = app.requests().filter((r) => r.url === `${BASE}/api/v1/slice/inbox`);
  expect(wakeInboxReqs[2]?.headers["last-event-id"]).toBe("5");
});

test("notifications encode/decode deep-link routes, sync app badge, notify high-priority arrivals, and navigate on press", async () => {
  expect(isHighPriorityInboxKind("ask")).toBe(true);
  expect(isHighPriorityInboxKind("review")).toBe(true);
  expect(isHighPriorityInboxKind("conflict")).toBe(true);
  expect(isHighPriorityInboxKind("quiet")).toBe(false);

  expect(decodeNotificationRoute(encodePermissionNotificationId("sess-1", "perm-1"))).toEqual({
    tab: "inbox",
    key: "perm:sess-1:perm-1",
  });
  expect(decodeNotificationRoute(encodeInteractionNotificationId("sess-1", "inter-1"))).toEqual({
    tab: "inbox",
    key: "inter:sess-1:inter-1",
  });
  expect(decodeNotificationRoute(encodeInboxNotificationId(InboxItemSchema.parse(sampleInboxSlice.items[0])))).toEqual({
    tab: "issues",
    issueId: "issue-1",
  });
  expect(
    decodeNotificationRoute(
      encodeInboxNotificationId(
        InboxItemSchema.parse({
          ...sampleInboxSlice.items[0],
          id: "inbox-chat-1",
          target: { kind: "chat", channel: "ch-1" },
        }),
      ),
    ),
  ).toEqual({
    tab: "channels",
    channelId: "ch-1",
  });
  expect(
    decodeNotificationRoute(
      encodeInboxNotificationId(
        InboxItemSchema.parse({
          ...sampleInboxSlice.items[0],
          id: "inbox-sess-1",
          target: { kind: "session", id: "sess-1" },
        }),
      ),
    ),
  ).toEqual({
    tab: "sessions",
    sessionId: "sess-1",
  });

  const shown: { id: string; title: string; body?: string | null }[] = [];
  const badges: number[] = [];
  let closedAll = 0;
  let inboxCalls = 0;

  const secondInbox = {
    ...sampleInboxSlice,
    seq: 6,
    items: [
      ...sampleInboxSlice.items,
      {
        id: "inbox-quiet-1",
        kind: "quiet",
        from: { kind: "orchestrator" },
        who: "Orchestrator",
        text: "Low priority background note",
        at: NOW + 100,
        target: { kind: "chat", channel: "ch-1" },
        words: { label: "Note", title: "Background note", body: "No popup", tray: "Note" },
      },
      {
        id: "inbox-mention-2",
        kind: "mention",
        from: { kind: "orchestrator" },
        who: "Orchestrator",
        text: "Please check #general",
        at: NOW + 200,
        target: { kind: "chat", channel: "ch-1" },
        words: { label: "Mention", title: "Mention in #general", body: "Please check #general", tray: "Mention" },
      },
    ],
  };

  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessCredentialsStorage("iPhone"),
    host: {},
    modules: {
      nsh: {
        "Notifications.permission": () => "granted",
        "Notifications.requestPermission": () => "granted",
        "Notifications.show": (opts: { id: string; title: string; body?: string | null }) => {
          shown.push(opts);
          return true;
        },
        "Notifications.setBadge": (count: number) => {
          badges.push(count);
        },
        "Notifications.closeAll": () => {
          closedAll++;
        },
      },
    },
    network: createFullNetwork({
      [`GET ${BASE}/api/v1/slice/inbox`]: () => {
        inboxCalls++;
        return inboxCalls === 1 ? sseResponse([{ id: "1", data: sampleInboxSlice }]) : sseResponse([{ id: "6", data: secondInbox }]);
      },
    }),
  });

  await app.waitFor("id:inbox-permission-perm-1");
  await app.waitUntil(() => badges.includes(4));
  // Baseline items must not spam notifications on initial connect.
  expect(shown).toHaveLength(0);

  // Foreground resync delivers a quiet item + a high-priority mention; only the mention notifies.
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitUntil(() => shown.length === 1);
  expect(shown[0]).toMatchObject({
    id: "channel:ch-1:inbox-mention-2",
    title: "Mention in #general",
    body: "Please check #general",
  });
  await app.waitUntil(() => badges.at(-1) === 6);

  // Pressing the notification deep-links directly into the target channel.
  await app.host.send("notification.press", { id: shown[0].id });
  await app.waitFor("id:channel-detail");
  await app.waitFor("id:channel-message-msg-1");

  // Pressing an issue notification deep-links directly into the target issue detail.
  await app.host.send("notification.press", { id: "issue:issue-2:inbox-issue-2" });
  await app.waitFor("id:issue-detail");
  expect(app.texts()).toContain("#102 Add Tailscale diagnostics");

  // Pressing a session notification deep-links directly into the target session detail.
  await app.host.send("notification.press", { id: "session:sess-1:inbox-sess-1" });
  await app.waitFor("id:session-detail");
  await app.waitFor("id:session-event-1");

  // Disconnecting clears the app badge and removes delivered notifications.
  await app.press("id:disconnect-button");
  await app.waitFor("id:pair-screen");
  await app.waitUntil(() => badges.at(-1) === 0 && closedAll > 0);
});

test("SecureTokenStore keeps tokens out of plaintext Storage on mobile and supports native keychain round-trip", async () => {
  // 1. Direct SecureTokenStore contract check (save, load, missing-token invalidation, clear).
  const mem = new Map<string, string>();
  const customStore: SecureTokenStore = {
    backend: "native-keychain",
    getToken: (account) => Promise.resolve(mem.get(account)),
    setToken: (account, value) => {
      mem.set(account, value);
      return Promise.resolve();
    },
    deleteToken: (account) => {
      mem.delete(account);
      return Promise.resolve();
    },
  };
  await saveCredentials({ baseUrl: BASE, token: "vv_dev_secret_unit", deviceName: "UnitPhone", serverName: "UnitMac" }, customStore);
  expect(mem.get(TOKEN_ACCOUNT_KEY)).toBe("vv_dev_secret_unit");
  expect(await loadCredentials(customStore)).toEqual({
    baseUrl: BASE,
    token: "vv_dev_secret_unit",
    deviceName: "UnitPhone",
    serverName: "UnitMac",
  });
  await clearCredentials(customStore);
  expect(mem.has(TOKEN_ACCOUNT_KEY)).toBe(false);
  expect(await loadCredentials(customStore)).toBeUndefined();

  // 2. Native host keychain on iOS stores token ONLY in Keychain, never in plaintext Storage.
  const keychain = createHostKeychainStub();
  const iosWithKeychain = await open("./App.story.tsx", {
    platform: "ios",
    locale: "en-US",
    width: 390,
    height: 844,
    host: keychain.host,
    network: createFullNetwork(),
  });

  await iosWithKeychain.waitFor("id:pair-screen");
  await iosWithKeychain.type("id:pair-url-input", BASE);
  await iosWithKeychain.type("id:pair-code-input", "KEYCHAIN1");
  await iosWithKeychain.press("id:pair-submit");
  await iosWithKeychain.waitFor("id:mobile-home");

  expect(keychain.vault.get(TOKEN_ACCOUNT_KEY)).toBe(TOKEN);
  const allStorageValues = Object.values(iosWithKeychain.storage()).join("\n");
  expect(allStorageValues).not.toContain(TOKEN);
  expect(iosWithKeychain.storage()[PROFILE_STORAGE_KEY]).toBeDefined();

  await iosWithKeychain.press("id:disconnect-button");
  await iosWithKeychain.waitFor("id:pair-screen");
  expect(keychain.vault.has(TOKEN_ACCOUNT_KEY)).toBe(false);
  expect(iosWithKeychain.storage()[PROFILE_STORAGE_KEY]).toBeUndefined();

  // 3. Mobile without native keychain never writes plaintext token into Storage.
  const androidNoKeychain = await open("./App.story.tsx", {
    platform: "android",
    locale: "en-US",
    width: 840,
    height: 700,
    network: createFullNetwork(),
  });

  await androidNoKeychain.waitFor("id:pair-screen");
  await androidNoKeychain.type("id:pair-url-input", BASE);
  await androidNoKeychain.type("id:pair-code-input", "MEMONLY2");
  await androidNoKeychain.press("id:pair-submit");
  await androidNoKeychain.waitFor("id:mobile-home");

  const androidStorageValues = Object.values(androidNoKeychain.storage()).join("\n");
  expect(androidStorageValues).not.toContain(TOKEN);
  expect(androidNoKeychain.shows("id:mobile-nav-rail")).toBe(true);
});

test("recycling List views and TextView markdown render across Inbox, Channels, Sessions, and Issues", async () => {
  const markdownHistory = [
    {
      ...sampleChannelHistory[0],
      id: "msg-md-1",
      text: "Check **bold status** and `cargo test` output.",
    },
  ];
  const markdownBoard = {
    ...sampleBoardSlice,
    issues: [
      {
        ...sampleBoardSlice.issues[0],
        description: "Support **recycling lists** and `TextView` markdown.",
      },
      ...sampleBoardSlice.issues.slice(1),
    ],
  };

  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessCredentialsStorage("iPhone"),
    network: createFullNetwork({
      [`GET ${BASE}/api/v1/slice/board`]: sseResponse([{ id: "4", data: markdownBoard }]),
      [`POST ${BASE}/api/v1/channel/message/list`]: okEnvelope(markdownHistory),
    }),
  });

  await app.waitFor("id:inbox-list");
  expect(app.shows("id:inbox-list")).toBe(true);

  await app.press("id:tab-channels");
  await app.waitFor("id:channels-list");
  await app.press("id:channel-row-ch-1");
  await app.waitFor("id:channel-messages-list");
  await app.waitFor("id:channel-message-body-msg-md-1");
  expect(app.texts().join(" ")).toContain("bold status");
  expect(app.texts().join(" ")).toContain("cargo test");

  await app.press("id:tab-sessions");
  await app.waitFor("id:sessions-list");
  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-events-list");
  await app.waitFor("id:session-event-1");

  await app.press("id:tab-issues");
  await app.waitFor("id:issues-list");
  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-detail-description");
  expect(app.texts().join(" ")).toContain("recycling lists");
});

test("IssuesTab and SessionsTab support search filtering, empty-filter recovery CTA, and tap-to-copy ID feedback", async () => {
  const twoSessionsSlice = {
    ...sampleSessionsSlice,
    sessions: [
      sampleSessionsSlice.sessions[0],
      {
        ...sampleSessionsSlice.sessions[0],
        id: "sess-2",
        name: "Verifier Owl",
        runtime: "claude",
        brief: "Verify mobile search",
      },
    ],
  };

  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    clock: { time: NOW },
    storage: harnessCredentialsStorage("iPhone"),
    network: createFullNetwork({
      [`GET ${BASE}/api/v1/slice/sessions`]: sseResponse([{ id: "3", data: twoSessionsSlice }]),
    }),
  });

  await app.waitFor("id:mobile-home");

  // 1. IssuesTab search + clear + empty-filter recovery CTA + copy issue ref
  await app.press("id:tab-issues");
  await app.waitFor("id:issue-row-issue-1");

  await app.type("id:issue-search-input", "Tailscale");
  expect(app.shows("id:issue-row-issue-2")).toBe(true);
  expect(app.shows("id:issue-row-issue-1")).toBe(false);

  await app.clear("id:issue-search-input");
  await app.type("id:issue-search-input", "no-such-ticket");
  await app.waitFor("id:issues-empty");
  expect(app.shows("id:issues-clear-filters")).toBe(true);

  await app.press("id:issues-clear-filters");
  await app.waitFor("id:issue-row-issue-1");
  expect(app.value("id:issue-search-input")).toBe("");
  expect(app.shows("id:issue-row-issue-2")).toBe(true);
  expect(app.shows("id:issue-row-issue-3")).toBe(true);

  await app.press("id:issue-row-issue-1");
  await app.waitFor("id:issue-copy-id");
  await app.press("id:issue-copy-id");
  await app.waitUntil(() => app.clipboard() === "#101");
  expect(app.texts()).toContain("Copied");
  const clock = app.clock;
  if (!clock) throw new Error("expected manual virtual clock");
  await clock.fastForward(1_600);
  await app.waitUntil(() => !app.texts().includes("Copied"));

  // 2. SessionsTab search + clear + empty-filter recovery CTA + copy session ID
  await app.press("id:tab-sessions");
  await app.waitFor("id:session-row-sess-1");
  await app.waitFor("id:session-row-sess-2");

  await app.type("id:session-search-input", "Verifier");
  expect(app.shows("id:session-row-sess-2")).toBe(true);
  expect(app.shows("id:session-row-sess-1")).toBe(false);

  await app.press("id:session-search-clear");
  await app.waitFor("id:session-row-sess-1");
  expect(app.value("id:session-search-input")).toBe("");

  await app.type("id:session-search-input", "missing-helper");
  await app.waitFor("id:sessions-empty");
  expect(app.shows("id:sessions-clear-filters")).toBe(true);

  await app.press("id:sessions-clear-filters");
  await app.waitFor("id:session-row-sess-1");

  await app.press("id:session-row-sess-1");
  await app.waitFor("id:session-copy-id");
  await app.press("id:session-copy-id");
  await app.waitUntil(() => app.clipboard() === "sess-1");
  expect(app.texts()).toContain("Copied");
  await clock.fastForward(1_600);
  await app.waitUntil(() => !app.texts().includes("Copied"));
});

test("MobileApp manual refresh triggers immediate resync and connection recovery banner handles reconnecting and unauthorized", async () => {
  let inboxCalls = 0;

  const app = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessCredentialsStorage("iPhone"),
    network: createFullNetwork({
      [`GET ${BASE}/api/v1/slice/inbox`]: () => {
        inboxCalls++;
        if (inboxCalls === 1) {
          return {
            status: 503,
            headers: { "content-type": "text/plain" },
            body: "temporarily unavailable",
          };
        }
        return sseResponse([{ id: "1", data: sampleInboxSlice }]);
      },
    }),
  });

  await app.waitFor("id:mobile-home");
  await app.waitFor("id:connection-banner");
  await app.waitFor("id:connection-retry-button");
  expect(app.texts()).toContain("Connection lost, reconnecting…");

  await app.press("id:connection-retry-button");
  await app.waitFor("id:inbox-item-inbox-review-1");
  await app.waitUntil(() => app.texts().includes("Connected"));
  expect(app.count("id:connection-banner")).toBe(0);

  const callsBeforeRefresh = inboxCalls;
  await app.press("id:mobile-refresh-button");
  await app.waitUntil(() => inboxCalls > callsBeforeRefresh);
  const inboxReqs = app.requests().filter((r) => r.url === `${BASE}/api/v1/slice/inbox`);
  expect(inboxReqs.at(-1)?.headers["last-event-id"]).toBe("1");

  const revokedApp = await open("./App.story.tsx", {
    platform: "macos",
    locale: "en-US",
    width: 390,
    height: 844,
    storage: harnessCredentialsStorage("iPhone"),
    network: {
      [`GET ${BASE}/api/v1/slice/*`]: {
        status: 401,
        headers: { "content-type": "application/json" },
        body: { bizCode: BizCode.Unauthorized, message: "revoked" },
      },
    },
  });

  await revokedApp.waitFor("id:connection-banner");
  await revokedApp.waitFor("id:connection-repair-button");
  await revokedApp.press("id:connection-repair-button");
  await revokedApp.waitFor("id:pair-screen");
});
