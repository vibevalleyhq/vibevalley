// The chat page, settings and the inbox on the bridge, the Rust side played
// by fakeHost: the messages read with channel.message.list and followed
// with the channel.follow subscription, a line sent as channel.message.send,
// the settings sections from setting.get, the tray and notifications as
// host calls. Pictures come from chat.shots.test.tsx.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import type { InboxItem } from "@vibevalley/protocol";

import { messages } from "../fixtures/chat";
import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(options: { route?: string; width?: number } = {}) {
  const fake = fakeHost({ state, responses }, { route: options.route ?? "/chat" });
  const app = await open("./main.tsx", { width: options.width ?? 1200, height: 720, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await fake.pump(app);
  return { app, fake };
}

test("the general's messages through the bridge", async () => {
  const { app, fake } = await start();
  expect(app.count("id:chat-page")).toBe(1);
  expect(app.count("id:channels-side")).toBe(1);
  const texts = app.texts();
  for (const s of ["general", "设计", "发版", "小林", "登录过期的问题谁来修？", "收到，先看 session.ts。", "design-review.pdf", "登录页改版"])
    expect(texts).toContain(s);
  const ops = fake.calls.map((c) => c.op);
  expect(ops).toContain("channel.message.list");
  const follow = [...fake.subscriptions.values()].find((s) => s.name === "channel.follow");
  expect(follow?.payload).toEqual({ id: "general", after: 1 });
  expect(app.count("id:reaction-👍")).toBe(1);
  expect(app.count("id:thread-preview-t-login")).toBe(1);
});

test("a report folds the run behind it, opened on a press", async () => {
  const { app, fake } = await start();
  await fake.pump(app);
  expect(app.count("id:run-steps")).toBe(1);
  await app.press("id:run-steps");
  expect(app.count("id:work-log")).toBe(1);
});

test("a message heard on the follow shows", async () => {
  const { app, fake } = await start();
  const last = messages.at(-1);
  if (!last) throw new Error("no fixture messages");
  const heard = { ...last, id: "m99", number: 99, text: "新来的一句", deleted: undefined, at: Date.now() };
  delete (heard as { deleted?: number }).deleted;
  await fake.emit(app, "channel.follow", { _tag: "Message", message: heard }, (p: unknown) => (p as { id: string }).id === "general");
  expect(app.texts()).toContain("新来的一句");
});

test("a line typed and sent goes as channel.message.send", async () => {
  const { app, fake } = await start();
  await app.type("id:composer-input", "大家好");
  await app.press("id:send");
  await fake.pump(app);
  const sent = fake.calls.find((c) => c.op === "channel.message.send");
  expect((sent?.payload as { text?: string; id?: string } | undefined)?.text).toBe("大家好");
  expect((sent?.payload as { id?: string } | undefined)?.id).toBe("general");
});

test("a thread opens beside its channel", async () => {
  const { app } = await start({ route: "/chat/t-login" });
  expect(app.count("id:thread-pane")).toBe(1);
  expect(app.count("id:channel-main")).toBe(1);
});

test("the issues and crons tabs", async () => {
  const { app, fake } = await start();
  await app.press("id:tab-crons");
  await fake.pump(app);
  expect(app.count("id:cron-c1")).toBe(1);
  expect(app.texts().some((s) => s.startsWith("每天的站会"))).toBe(true);
  await app.press("id:tab-issues");
  await fake.pump(app);
  expect(app.count("id:tab-issues")).toBe(1);
});

test("narrow: the sidebar is a drawer", async () => {
  const { app, fake } = await start({ width: 560 });
  expect(app.count("id:channels-side")).toBe(0);
  await app.press("id:channels-drawer");
  await fake.pump(app);
  expect(app.count("id:channels-side")).toBe(1);
});

test("the quick switcher goes to a channel", async () => {
  const { app, fake } = await start();
  await app.press("id:switcher-open");
  await fake.pump(app);
  expect(app.count("id:switcher")).toBe(1);
});

test("settings: general, appearance, accounts, about", async () => {
  const { app, fake } = await start({ route: "/settings/general" });
  expect(app.count("id:settings-nav")).toBe(1);
  expect(app.count("id:language")).toBe(1);
  expect(app.count("id:start")).toBe(1);
  await app.press("id:settings-section-appearance");
  await fake.pump(app);
  expect(app.count("id:theme")).toBe(1);
  await app.press("id:settings-section-accounts");
  await fake.pump(app);
  expect(app.count("id:deepseek-form")).toBe(1);
  expect(app.count("id:readiness")).toBe(1);
  await app.press("id:settings-section-about");
  await fake.pump(app);
  expect(app.texts()).toContain("0.42.0");
});

test("a new call in the inbox is a notification and the tray says it", async () => {
  const { app, fake } = await start({ route: "/issues" });
  const call = {
    id: "c1",
    target: { kind: "issue", id: "i18" },
    words: { title: "老周在等你", body: "看一眼登录的改动", tray: "老周在等你" },
    at: Date.now(),
  } as unknown as InboxItem;
  await app.setLifecycle("background");
  await fake.setState(app, { ...state, inbox: [call] });
  const ops = fake.calls.map((c) => c.op);
  expect(ops).toContain("host.tray");
  expect(ops).toContain("host.notify");
  expect(app.count("id:rail-badge")).toBe(1);
});

test("attachments: a picture shows itself once the server says where its file is; a file opens in the system's app", async () => {
  const { app, fake } = await start();
  await fake.pump(app);
  expect(fake.calls.filter((c) => c.op === "attachment.file").map((c) => c.payload)).toContainEqual({ id: "a3" });
  await app.press("id:attachment-design-review.pdf");
  await fake.pump(app);
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "host.openFile")?.payload).toEqual({ path: "/Users/farmer/.vibevalley/attachments/login.png" });
});

test("attachments: a picture opens in the Lightbox, a video in a player, a sound plays through the host", async () => {
  const { app, fake } = await start();
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:lightbox-name")).toBe(0);
  await app.press("id:attachment-login.png");
  await app.waitFor("id:lightbox-name");
  expect(app.texts()).toContain("login.png");
  await app.press("id:lightbox-original");
  await fake.pump(app);
  expect(fake.calls.filter((c) => c.op === "host.openFile").length).toBe(1);
  await app.press("id:lightbox-close");
  await app.waitUntil(() => app.count("id:lightbox-name") === 0);
  expect(app.count("id:attachment-bug.mov")).toBe(1);
  await app.press("id:attachment-play");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "host.playAudio")?.payload).toEqual({ path: "/Users/farmer/.vibevalley/attachments/login.png" });
  await app.press("id:attachment-play");
  await fake.pump(app);
  expect(fake.calls.map((c) => c.op)).toContain("host.stopAudio");
});

test("the attach button: picked files upload as attachment.create and wait in the box", async () => {
  const { app, fake } = await start();
  app.onPick(() => [{ name: "notes.txt", type: "text/plain", data: new TextEncoder().encode("hello") }]);
  await app.press("id:attach");
  await app.waitUntil(() => fake.calls.some((c) => c.op === "attachment.create"));
  await fake.pump(app);
  expect(app.picks()[0]?.kind).toBe("files");
  expect(fake.calls.find((c) => c.op === "attachment.create")?.payload).toEqual({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" });
  await fake.pump(app);
  expect(app.texts().join(" ")).toContain("notes.txt");
});

test("files dropped on the pane: the host reads them, they upload as attachment.create", async () => {
  const { app, fake } = await start();
  await app.dropFiles("id:composer", ["file:///Users/farmer/notes.txt"]);
  await app.waitUntil(() => fake.calls.some((c) => c.op === "host.readFile"));
  await fake.pump(app);
  await app.waitUntil(() => fake.calls.some((c) => c.op === "attachment.create"));
  expect(fake.calls.find((c) => c.op === "host.readFile")?.payload).toEqual({ path: "file:///Users/farmer/notes.txt" });
  expect(fake.calls.find((c) => c.op === "attachment.create")?.payload).toEqual({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" });
});
