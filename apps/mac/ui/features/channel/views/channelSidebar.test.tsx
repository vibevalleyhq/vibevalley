import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Channel, Chat, SettingsStatus, SliceBundle } from "@vibevalley/protocol";

import { fakeHost, type FakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, type ScenarioDensity, scenarios } from "../../../fixtures/scenarios";
import { channelTime, sidebarChannelsOf } from "../model/places";

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
      makeDirect("dm-worker", "小林", "profile:xiaolin", { at: SCENARIO_NOW - 10 * min }),
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
        last: { from: "user", name: "你", text: "看看今日进展", at: SCENARIO_NOW - 3 * min },
      }),
      makeDirect("d-orchestrator", "全能主助手", "orchestrator", {
        at: SCENARIO_NOW - 2 * min,
        last: { from: "orchestrator", name: "全能主助手", text: "我随时待命", at: SCENARIO_NOW - 1 * min },
      }),
      makeDirect("d-xiaolin", "小林", "profile:xiaolin", {
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

  const missingChat = await mountChat("typical", (f) => {
    f.respond("setting.get", {
      ...baseSettings,
      readiness: { ...baseSettings.readiness, orchestrator: { ready: false, missing: "deepseekKey" } },
    });
  });
  await missingChat.fake.pumpUntil(missingChat.app, () => missingChat.app.count("id:channel-readiness-alert") === 1);
  expect(missingChat.app.count("id:orchestrator-fix")).toBe(1);
});
