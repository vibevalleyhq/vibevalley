import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { agentParticipant, type Channel, type Chat, localUserParticipant, type MessageId, type SettingsStatus, type SliceBundle } from "@vibevalley/protocol";

import { fakeHost, type FakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, type ScenarioDensity, scenarios } from "../../../fixtures/scenarios";
import { channelTime, feedOf, sidebarChannelsOf } from "../model/places";

const min = 60_000;
const day = 24 * 60 * min;

function makeChannel(id: string, more: Partial<Channel> = {}): Channel {
  return {
    id,
    type: "channel",
    default: false,
    category: "",
    notify: "all",
    description: "",
    subjectKind: null,
    replies: 0,
    title: id,
    name: id,
    at: SCENARIO_NOW - 60 * min,
    ...more,
  };
}

function makeDirect(id: string, title: string, peer: string, more: Partial<Channel> = {}): Channel {
  return {
    ...makeChannel(id, more),
    type: "direct",
    peer,
    title,
    name: undefined,
  };
}

async function mountChat(density: ScenarioDensity, configure?: (fake: FakeHost) => void, opts?: { locale?: "zh" | "en"; state?: SliceBundle }) {
  const base = scenarios[density];
  const fixture = opts?.state ? { state: opts.state, responses: base.responses } : base;
  const fake = fakeHost(fixture, { route: "/chat", ...(opts?.locale ? { locale: opts.locale } : {}) });
  configure?.(fake);
  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake };
}

test("sidebarChannelsOf pins the default channel first and sorts channels and directs by recent activity", () => {
  const chat: Chat = {
    channels: [
      makeChannel("old-group", { at: SCENARIO_NOW - 120 * min }),
      makeDirect("dm-orc", "全能主助手", "orchestrator", {
        at: SCENARIO_NOW - 50 * min,
        last: { from: "orchestrator", name: "全能主助手", text: "你好", at: SCENARIO_NOW - 2 * min },
      }),
      makeChannel("general", { default: true, at: SCENARIO_NOW - 200 * min }),
      makeDirect("dm-worker", "小林", agentParticipant("xiaolin"), { at: SCENARIO_NOW - 10 * min }),
      makeChannel("archived-group", { archived: SCENARIO_NOW - 5 * min, at: SCENARIO_NOW - 1 * min }),
      makeChannel("t1", { type: "thread", parent: "general", at: SCENARIO_NOW - 1 * min }),
    ],
    userMentions: [],
  };

  expect(sidebarChannelsOf(chat, "all").map((c) => c.id)).toEqual(["general", "dm-orc", "dm-worker", "old-group"]);
  expect(sidebarChannelsOf(chat, "group").map((c) => c.id)).toEqual(["general", "old-group"]);
  expect(sidebarChannelsOf(chat, "direct").map((c) => c.id)).toEqual(["dm-orc", "dm-worker"]);
});

test("channelTime formats today, yesterday, same-year dates, and earlier years", () => {
  setLocale("zh");
  const now = new Date(2026, 10, 25, 14, 30).getTime();
  expect(channelTime(undefined, now)).toBe("");
  expect(channelTime(0, now)).toBe("");
  expect(channelTime(new Date(2026, 10, 25, 9, 5).getTime(), now)).toBe("09:05");
  expect(channelTime(new Date(2026, 10, 24, 20, 0).getTime(), now)).toBe(t("web.base.time.yesterday"));
  expect(channelTime(new Date(2026, 10, 20, 10, 0).getTime(), now)).toBe("11/20");
  expect(channelTime(new Date(2025, 11, 31, 10, 0).getTime(), now)).toBe("2025/12/31");
});

test("Sidebar renders a unified chat list without session section, filters channels/directs, and opens new-chat menu", async () => {
  setLocale("zh");
  const base = scenarios.typical;
  const customChat: Chat = {
    userMentions: base.state.collab.chat?.userMentions ?? [],
    channels: [
      makeChannel("general", {
        default: true,
        orchestrator: "orchestrator",
        members: ["orchestrator"],
        unread: 3,
        last: { from: localUserParticipant, name: "你", text: "看看今日进展", at: SCENARIO_NOW - 3 * min },
      }),
      makeDirect("d-orchestrator", "全能主助手", "orchestrator", {
        at: SCENARIO_NOW - 2 * min,
        last: { from: "orchestrator", name: "全能主助手", text: "我随时待命", at: SCENARIO_NOW - 1 * min },
      }),
      makeDirect("d-xiaolin", "小林", agentParticipant("xiaolin"), {
        at: SCENARIO_NOW - day,
      }),
    ],
  };
  const state: SliceBundle = {
    ...base.state,
    collab: { ...base.state.collab, chat: customChat, channelSummary: undefined },
  };
  const { app, fake } = await mountChat("typical", undefined, { state });
  await fake.pumpUntil(app, () => app.count("id:channels-side") === 1);

  expect(app.count("id:side-section-helpers")).toBe(0);
  expect(app.count("id:side-section-channels")).toBe(0);
  expect(app.count("id:side-section-directs")).toBe(0);
  expect(app.count("id:channel-orchestrator-line")).toBe(0);
  expect(app.count("id:channel-row-general")).toBe(1);
  expect(app.count("id:channel-row-d-orchestrator")).toBe(1);
  expect(app.count("id:channel-row-d-xiaolin")).toBe(1);

  await app.press("id:chat-filter-group");
  expect(app.count("id:channel-row-general")).toBe(1);
  expect(app.count("id:channel-row-d-orchestrator")).toBe(0);

  await app.press("id:chat-filter-direct");
  expect(app.count("id:channel-row-general")).toBe(0);
  expect(app.count("id:channel-row-d-orchestrator")).toBe(1);
  expect(app.count("id:channel-row-d-xiaolin")).toBe(1);

  await app.press("id:chat-filter-all");
  expect(app.count("id:channel-row-general")).toBe(1);
  expect(app.count("id:channel-row-d-orchestrator")).toBe(1);

  await app.press("id:chat-new");
  await fake.pumpUntil(app, () => app.count("id:direct-picker") === 1);
  expect(app.count("id:new-channel")).toBe(1);
  expect(app.count("id:direct-picker")).toBe(1);

  await app.press("id:chat-open-runs");
  await fake.pumpUntil(app, () => app.count("id:runs-page") === 1);
  expect(app.count("id:runs-page")).toBe(1);
});

test("Sidebar only renders channel-readiness-alert when orchestrator readiness is missing", async () => {
  setLocale("zh");
  const baseSettings = scenarios.typical.responses["setting.get"] as SettingsStatus;

  const readyChat = await mountChat("typical", (f) => {
    f.respond("setting.get", {
      ...baseSettings,
      readiness: { ...baseSettings.readiness, orchestrator: { ready: true } },
    });
  });
  await readyChat.fake.pumpUntil(readyChat.app, () => readyChat.app.count("id:channels-side") === 1);
  expect(readyChat.app.count("id:channel-readiness-alert")).toBe(0);

  const missingChat = await mountChat(
    "typical",
    (f) => {
      f.respond("setting.get", {
        ...baseSettings,
        readiness: { ...baseSettings.readiness, orchestrator: { ready: false, missing: "deepseekKey" } },
      });
    },
    {
      state: {
        ...scenarios.typical.state,
        collab: {
          ...scenarios.typical.state.collab,
          chat: {
            userMentions: [],
            channels: [
              makeChannel("general", { default: true }),
              makeDirect("d-orchestrator", "全能主助手", "orchestrator", {
                at: SCENARIO_NOW - 2 * min,
                last: { from: "orchestrator", name: "全能主助手", text: "我随时待命", at: SCENARIO_NOW - 1 * min },
              }),
            ],
          },
        },
      },
    },
  );
  await missingChat.fake.pumpUntil(missingChat.app, () => missingChat.app.count("id:channel-readiness-alert") === 1);
  expect(missingChat.app.count("id:orchestrator-fix")).toBe(1);
  // Readiness alert lives inside the main conversation area rather than cramped in the narrow sidebar.
  expect(missingChat.app.count("id:channel-main >> id:channel-readiness-alert")).toBe(1);
  expect(missingChat.app.count("id:channels-side >> id:channel-readiness-alert")).toBe(0);
  // Warning is shown once in the conversation alert banner, not duplicated in the orchestrator DM preview row.
  const warnText = "回不了话：还没填 DeepSeek 的钥匙";
  expect(missingChat.app.texts().filter((line) => line === warnText).length).toBe(1);
  expect(missingChat.app.shows("id:channel-row-d-orchestrator >> text:我随时待命")).toBe(true);
  // Rail, sidebar header, and chat tab use unified 频道 terminology.
  expect(missingChat.app.texts()).not.toContain("聊天");
  expect(missingChat.app.texts()).not.toContain("对话");
  expect(missingChat.app.texts().filter((line) => line === "频道").length).toBeGreaterThanOrEqual(2);
});

test("Chat localizes raw runtime API-key error in channel sidebar preview, thread preview card, and threads list", async () => {
  setLocale("zh");
  const rawErr = "no API key is set for the model";
  const localized = t("web.issue.error.missingApiKey");
  const base = scenarios.typical;
  const general = makeChannel("general", {
    default: true,
    orchestrator: "orchestrator",
    members: ["orchestrator"],
    last: { from: "w1", name: "Ada #4", text: rawErr, at: SCENARIO_NOW - 2 * min },
  });
  const thread = makeChannel("general:1", {
    type: "thread",
    parent: "general",
    root: "m-root" as MessageId,
    rootNumber: 1,
    title: "Ada #4",
    name: "Ada #4",
    replies: 1,
    last: { from: "w1", name: "Ada #4", text: rawErr, at: SCENARIO_NOW - min },
  });
  const state: SliceBundle = {
    ...base.state,
    collab: {
      ...base.state.collab,
      chat: {
        userMentions: [],
        channels: [general, thread],
      },
      channelSummary: undefined,
    },
  };
  const { app, fake } = await mountChat(
    "typical",
    (f) => {
      f.respond("channel.message.list", [
        {
          id: "m-root",
          channel: "general",
          number: 1,
          from: "orchestrator",
          name: "全能主助手",
          actor: { kind: "agent", role: "orchestrator", id: "orchestrator" },
          kind: "chat",
          text: "已派 Ada 处理 #4",
          at: SCENARIO_NOW - 3 * min,
          attachments: [],
          embeds: [],
          reactions: [],
        },
      ]);
    },
    { locale: "zh", state },
  );
  await fake.pumpUntil(app, () => app.count("id:thread-preview-general:1") === 1);

  expect(app.texts().join("\n")).not.toContain("no API key is set");
  expect(app.shows(`id:channel-row-general >> text:Ada #4: ${localized}`)).toBe(true);
  expect(app.shows(`id:thread-preview-general:1 >> text:${localized}`)).toBe(true);

  await app.press("id:channel-more-menu");
  await fake.pumpUntil(app, () => app.count("id:more-threads") === 1);
  await app.press("id:more-threads");
  await fake.pumpUntil(app, () => app.count("id:thread-general:1") === 1);
  expect(app.texts().join("\n")).not.toContain("no API key is set");
  expect(app.shows(`id:thread-general:1 >> text:${t("shared.join.labeled", { label: "Ada #4", text: localized })}`)).toBe(true);
});

test("feedOf does not fold a follow-up message directly under a reacted message", () => {
  setLocale("zh");
  const first = {
    id: "m1" as MessageId,
    channel: "general",
    number: 1,
    from: localUserParticipant,
    name: "你",
    actor: { kind: "user" as const, id: localUserParticipant, name: "你" },
    kind: "chat" as const,
    text: "第一段",
    at: SCENARIO_NOW - 2 * min,
    revision: 1,
    mentions: [],
    spoken: false,
    reactions: [{ emoji: "👍", by: ["orchestrator"] }],
    attachments: [],
    embeds: [],
    outcome: null,
  };
  const second = { ...first, id: "m2" as MessageId, number: 2, text: "第二段", at: SCENARIO_NOW - min, reactions: [] };
  const third = { ...second, id: "m3" as MessageId, number: 3, text: "第三段", at: SCENARIO_NOW - 30_000 };
  const items = feedOf(undefined, [first, second, third], "", new Date(SCENARIO_NOW));
  expect(items[0]?.continues).toBe(false);
  expect(items[1]?.continues).toBe(false);
  expect(items[2]?.continues).toBe(true);
});

test("Chat does not carry stale cross-page note context pill when navigating from /notes to /chat", async () => {
  setLocale("zh");
  const fake = fakeHost(scenarios.typical, { route: "/notes", locale: "zh" });
  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  await app.press("text:频道");
  await fake.pumpUntil(app, () => app.count("id:composer") === 1);
  expect(app.count("id:note-context-pill")).toBe(0);
});
