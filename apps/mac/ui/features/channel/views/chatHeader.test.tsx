import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { isWideChannelHead } from "./ChatPage";

test("isWideChannelHead folds tabs into header >= 960px only when main pane is wide enough", () => {
  expect(isWideChannelHead(720, 644, false)).toBe(false);
  expect(isWideChannelHead(900, 536, false)).toBe(false);
  expect(isWideChannelHead(959, 595, false)).toBe(false);
  expect(isWideChannelHead(960, 596, false)).toBe(true);
  expect(isWideChannelHead(1280, 916, false)).toBe(true);
  expect(isWideChannelHead(1280, 916, true)).toBe(true);
  expect(isWideChannelHead(1280, 500, false)).toBe(false);
  expect(isWideChannelHead(960, 596, true)).toBe(false);
});

async function mountChatAt(width: number, height: number, locale: "en" | "zh") {
  setLocale(locale);
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale });
  const app = await open("../../../app/main.tsx", {
    width,
    height,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:channel-head") === 1);
  return { app, fake };
}

test("ChatPage folds secondary tabs into h-11 channel-head at >= 960px and falls back cleanly at 720-959px", async () => {
  for (const locale of ["en", "zh"] as const) {
    const wide = await mountChatAt(960, 820, locale);
    const wideHead = wide.app.layout("id:channel-head")!;
    expect(wideHead.height).toBeLessThanOrEqual(45);
    expect(wide.app.count("id:channel-head-tabs")).toBe(1);
    expect(wide.app.count("id:channel-subbar-tabs")).toBe(0);

    for (const id of ["channel-head-tabs", "tab-chat", "tab-issues", "tab-crons", "message-search-toggle", "channel-more-menu", "channel-settings-open"]) {
      const box = wide.app.layout(`id:${id}`)!;
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(wideHead.x);
      expect(box.x + box.width).toBeLessThanOrEqual(wideHead.x + wideHead.width);
      expect(box.y).toBeGreaterThanOrEqual(wideHead.y);
      expect(box.y + box.height).toBeLessThanOrEqual(wideHead.y + wideHead.height + 1);
    }

    // Secondary actions live inside channel-more-menu rather than crowding the top bar.
    expect(wide.app.count("id:threads-toggle")).toBe(0);
    expect(wide.app.count("id:pins-toggle")).toBe(0);
    expect(wide.app.count("id:members-toggle")).toBe(0);
    expect(wide.app.count("id:listen-reports-toggle")).toBe(0);

    await wide.app.press("id:channel-more-menu");
    await wide.fake.pumpUntil(wide.app, () => wide.app.count("id:more-threads") === 1);
    expect(wide.app.count("id:more-pins")).toBe(1);
    expect(wide.app.count("id:more-members")).toBe(1);
    expect(wide.app.count("id:more-listen-reports")).toBe(1);
    await wide.app.keyboard.press("escape");
    await wide.fake.pumpUntil(wide.app, () => wide.app.count("id:more-threads") === 0);

    await wide.app.press("id:tab-crons");
    await wide.fake.pump(wide.app);
    expect(wide.app.count("id:cron-c1") + wide.app.count("id:tab-empty")).toBeGreaterThanOrEqual(1);

    // Narrow 720px & 900px keep channel-head clean at h-11 and move tabs to the secondary row.
    for (const width of [720, 900]) {
      const narrow = await mountChatAt(width, 800, locale);
      const narrowHead = narrow.app.layout("id:channel-head")!;
      expect(narrowHead.height).toBeLessThanOrEqual(45);
      expect(narrow.app.count("id:channel-head-tabs")).toBe(0);
      expect(narrow.app.count("id:channel-subbar-tabs")).toBe(1);

      const subbar = narrow.app.layout("id:channel-subbar-tabs")!;
      expect(subbar.y).toBeGreaterThanOrEqual(narrowHead.y + narrowHead.height - 1);
      for (const id of ["tab-chat", "tab-issues", "tab-crons"]) {
        const box = narrow.app.layout(`id:${id}`)!;
        expect(box.x).toBeGreaterThanOrEqual(subbar.x);
        expect(box.x + box.width).toBeLessThanOrEqual(subbar.x + subbar.width);
      }
      for (const id of ["message-search-toggle", "channel-more-menu", "channel-settings-open"]) {
        const box = narrow.app.layout(`id:${id}`)!;
        expect(box.x + box.width).toBeLessThanOrEqual(narrowHead.x + narrowHead.width);
      }
    }
  }
});

test("Chat messages render calm localized video attachment cards and hide raw note file-extension pills", async () => {
  setLocale("zh");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "zh" });
  fake.respond("attachment.file", () => ({ path: "/tmp/demo-clip.mp4", type: "video/mp4", name: "demo-clip.mp4" }));
  fake.respond("channel.message.list", () => [
    {
      id: "m-video-note",
      channel: "general",
      number: 1,
      from: "orchestrator",
      name: "老村长",
      actor: { kind: "agent", id: "orchestrator", role: "orchestrator", forUser: false },
      kind: "chat",
      text: "附上演示视频和架构笔记",
      mentions: [],
      spoken: false,
      at: SCENARIO_NOW - 10_000,
      revision: 1,
      reactions: [],
      embeds: [],
      attachments: [{ id: "att-vid", name: "demo-clip.mp4", type: "video/mp4", size: 2_048_000 }],
      note: { id: "n-arch", title: "架构设计", noteType: "doc", version: 2, note: "初稿" },
    },
  ]);

  const app = await open("../../../app/main.tsx", {
    width: 1100,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:attachment-demo-clip.mp4") === 1 && app.count("id:note-card") === 1);

  const allText = app.texts().join("\n");
  expect(allText).not.toContain("Video is not available");
  expect(app.shows("id:attachment-demo-clip.mp4 >> text:demo-clip.mp4")).toBe(true);
  expect(app.shows("id:attachment-demo-clip.mp4 >> text:系统打开")).toBe(true);

  expect(app.shows("id:note-card >> text:架构设计")).toBe(true);
  expect(allText).not.toContain(".md");
});
