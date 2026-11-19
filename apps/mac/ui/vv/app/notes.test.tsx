// The notes (/pkm) on the fixture vault (fixtures/pkm.ts, served in memory):
// the stream of days, a page with its rail, writing in the outline with
// VibeValley's keys, picking blocks, the search, a suggested rewrite.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(route: string, width = 1400) {
  const fake = fakeHost({ state, responses }, { route });
  const app = await open("./main.tsx", { width, height: 900, colorScheme: "light", platform: "macos", host: fake.options });
  for (let i = 0; i < 4; i++) await fake.pump(app);
  return { app, fake };
}

const applied = (fake: { calls: { op: string; payload: unknown }[] }) =>
  fake.calls.filter((c) => c.op === "pkm.block.apply").flatMap((c) => (c.payload as { ops: { op: string }[] }).ops);

test("the days: today's journal opened, the days before it, the calendar, the tiers", async () => {
  const { app, fake } = await start("/pkm");
  expect(fake.calls.map((c) => c.op)).toContain("pkm.journal.open");
  expect(app.count("id:pkm-day")).toBe(3);
  expect(app.count("id:pkm-calendar")).toBe(1);
  expect(app.count("id:pkm-journal-dot")).toBeGreaterThan(0);
  expect(app.count("id:pkm-row")).toBe(6);
  expect(app.texts()).toContain("VibeValley 原生移植");
  expect(app.count("id:pkm-radar-overdue")).toBe(1);
});

test("a page: title, properties, outline, remarks, backlinks, contents", async () => {
  const { app } = await start("/pkm/vibevalley-原生移植");
  expect(app.count("id:pkm-page")).toBe(1);
  expect(app.count("id:pkm-block")).toBe(14);
  expect(app.count("id:pkm-prop-status")).toBe(1);
  expect(app.count("id:pkm-prop-tag")).toBe(2);
  expect(app.count("id:pkm-comment")).toBe(1);
  expect(app.count("id:pkm-diff")).toBe(1);
  expect(app.count("id:pkm-contents")).toBe(1);
  expect(app.count("id:pkm-marker")).toBe(5);
  // The journal links here.
  expect(app.count("id:pkm-backlink")).toBe(1);
  // The ((ref)) is read out: the block it names, in its place.
  expect(app.texts().join(" ")).not.toContain("((");
});

test("writing: a press opens the box, Return splits, Tab indents, the ops go to the server", async () => {
  const { app, fake } = await start("/pkm/健康");
  expect(app.count("id:pkm-block")).toBe(2);
  await app.press("text:体检约在月底");
  expect(app.count("id:pkm-editor")).toBe(1);
  await app.type("id:pkm-editor", "，带上报告");
  await app.submit("id:pkm-editor");
  await fake.pump(app);
  expect(app.count("id:pkm-block")).toBe(3);
  await app.keyboard.press("tab");
  await app.waitUntil(() => applied(fake).some((o) => o.op === "indent"));
  await fake.pump(app);
  expect(applied(fake).map((o) => o.op)).toEqual(["update", "insert_after", "indent"]);
  await app.keyboard.press("escape");
  await fake.pump(app);
  expect(app.count("id:pkm-editor")).toBe(0);
});

test("a / command marks the block, [[ offers the pages", async () => {
  const { app, fake } = await start("/pkm/工作");
  await app.press("text:VibeValley 和 VibeValley 的事都在这里");
  await app.clear("id:pkm-editor");
  await app.type("id:pkm-editor", "/doi");
  expect(app.count("id:pkm-complete")).toBe(1);
  await app.press("id:pkm-choice");
  await fake.pump(app);
  expect(applied(fake).some((o) => o.op === "set_marker")).toBe(true);
  await app.type("id:pkm-editor", "[[Ep");
  expect(app.texts()).toContain("VibeValley 原生移植");
});

test("Escape picks the block; ↓ with Shift picks the next; Delete takes them away", async () => {
  const { app, fake } = await start("/pkm/想到的");
  await app.press("text:图鉴里加一个调色板");
  await app.keyboard.press("escape");
  await app.keyboard.press("shift+down");
  await app.keyboard.press("backspace");
  await fake.pump(app);
  expect(applied(fake).filter((o) => o.op === "delete").length).toBe(2);
});

test("the search: pages by title, blocks from pkm.search", async () => {
  const { app, fake } = await start("/pkm");
  await app.press("id:pkm-find");
  expect(app.count("id:pkm-search")).toBe(1);
  await app.type("id:pkm-search-input", "音效");
  await app.wait(300);
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:pkm-search-row") > 0);
  expect(fake.calls.some((c) => c.op === "pkm.search")).toBe(true);
});

test("a suggested rewrite accepted", async () => {
  const { app, fake } = await start("/pkm/vibevalley-原生移植");
  await app.press("id:pkm-accept");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "pkm.comment.resolve")?.payload).toEqual({ id: "c1", accept: true });
});

test("the quick switcher finds a note by its title and offers to search the notes", async () => {
  const { app, fake } = await start("/pkm");
  await app.keyboard.press("mod+k");
  await fake.pump(app);
  await app.type("id:switcher-input", "健康");
  await app.waitUntil(() => app.texts().some((s) => s.includes("健康")));
  expect(app.texts()).toContain("笔记 · 领域");
  await app.keyboard.press("enter");
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:pkm-page") === 1);
});

test("a block dragged by its bullet onto the row above goes before it; the radar's inbox count jumps to the inbox", async () => {
  const { app, fake } = await start("/pkm/rust-笔记");
  expect(app.count("id:pkm-block")).toBe(2);
  await app.dragAndHold("id:pkm-bullet >> nth=1", { x: 0, y: -30 });
  expect(app.count("id:pkm-drop-before")).toBe(1);
  await app.drop();
  await app.waitUntil(() => applied(fake).some((o) => o.op === "move_to"));
  const moved = applied(fake).find((o) => o.op === "move_to") as { op: string; at?: string };
  expect(moved.at).toBe("before");
  expect(app.count("id:pkm-drop-before")).toBe(0);
  await app.press("id:pkm-radar-inbox");
  expect(app.count("id:pkm-tier-inbox")).toBe(1);
});
