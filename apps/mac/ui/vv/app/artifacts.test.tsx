// The artifacts on the fixture (fixtures/artifacts.ts): the list and its
// groups, a written blocks one, an html one's versions and reply, making and
// deleting, the issue's artifacts, the card and canvas in a chat, the
// speaker's view. A web view's page is not run headless: what its runtime
// says is checked on frame.ts (frame.test.ts).
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

const ops = (fake: { calls: { op: string }[] }) => fake.calls.map((c) => c.op);

test("the list: delivered, then the user's own; the first one opens; the search narrows it", async () => {
  const { app } = await start("/artifacts");
  expect(app.count("id:artifact-group-delivered")).toBe(1);
  expect(app.count("id:artifact-group-mine")).toBe(1);
  expect(app.count("id:artifact-row-art-plan")).toBe(1);
  expect(app.value("id:artifact-title")).toBe("看板拖拽的方案");
  await app.waitFor("id:artifact-block");
  await app.waitUntil(() => app.count("id:artifact-block") === 10);
  expect(app.texts()).toContain("手感比动画重要。");
  await app.type("id:artifact-search", "发版");
  expect(app.count("id:artifact-row-art-mine")).toBe(1);
  expect(app.count("id:artifact-row-art-plan")).toBe(0);
});

test("a blocks one: by whom, its issue, the rail with nowhere to reply; the rail shuts", async () => {
  const { app } = await start("/artifacts/art-mine");
  await app.waitUntil(() => app.count("id:artifact-block") === 3);
  expect(app.count("id:artifact-unsaid")).toBe(1);
  await app.press("id:artifact-rail-toggle");
  expect(app.count("id:artifact-rail")).toBe(0);
  const plan = await start("/artifacts/art-plan");
  expect(plan.app.count("id:artifact-issue")).toBe(1);
});

test("an html one: its frame, its versions, an older one picked, a reply under its message", async () => {
  const { app, fake } = await start("/artifacts/art-login");
  expect(app.count("id:artifact-frame")).toBe(1);
  expect(ops(fake)).toContain("artifact.content.get");
  expect(app.count("id:artifact-version-1")).toBe(1);
  expect(app.count("id:artifact-version-2")).toBe(1);
  await app.press("id:artifact-version-1");
  await fake.pump(app);
  expect(app.texts().join(" ")).toContain("第一版");
  const asked = fake.calls.filter((c) => c.op === "artifact.content.get").map((c) => (c.payload as { version: number }).version);
  expect(asked).toContain(1);
  await app.type("id:artifact-reply", "第二步再细一点");
  await app.press("id:artifact-send");
  await fake.pump(app);
  const sent = fake.calls.find((c) => c.op === "channel.message.send")?.payload as { id: string; text: string; replyTo?: number };
  expect(sent.id).toBe("general");
  expect(sent.text).toBe("第二步再细一点");
  expect(sent.replyTo).toBe(2);
});

test("new makes an untitled blocks one; delete asks first", async () => {
  const { app, fake } = await start("/artifacts/art-mine");
  await app.press("id:new-artifact");
  await fake.pump(app);
  expect(ops(fake)).toContain("artifact.create");
  const again = await start("/artifacts/art-mine");
  await again.app.press("id:artifact-more");
  await again.app.press("id:more-delete");
  expect(again.app.count("id:artifact-delete")).toBe(1);
  await again.app.press("id:artifact-delete-sure");
  await again.fake.pump(again.app);
  expect(ops(again.fake)).toContain("artifact.delete");
});

test("an issue's artifacts; the card in a chat opens the canvas beside the talk, whose blocks quote into the box", async () => {
  const issue = await start("/issues/i18");
  await issue.app.waitFor("id:issue-artifacts");
  expect(issue.app.texts()).toContain("登录流程");
  const { app, fake } = await start("/chat/general");
  await app.waitFor("id:artifact-card");
  await app.press("id:artifact-card");
  await fake.pump(app);
  expect(app.count("id:artifact-canvas")).toBe(1);
  expect(app.count("id:artifact-canvas-frame")).toBe(1);
  const plan = await start("/chat/general?artifact=art-plan");
  await plan.app.waitUntil(() => plan.app.count("id:artifact-block") === 10);
  await plan.app.press("id:artifact-quote-block >> nth=0");
  expect(plan.app.count("id:quoted-block-art-plan-b1")).toBe(1);
});

test("the speaker's view: the deck, the clock, a way back; without a deck it says so", async () => {
  const { app } = await start("/present?artifact=art-deck&v=1");
  expect(app.count("id:presenter")).toBe(1);
  expect(app.count("id:presenter-current")).toBe(1);
  expect(app.count("id:presenter-clock")).toBe(1);
  const none = await start("/present");
  expect(none.app.count("id:presenter")).toBe(0);
});

test("writing: a press below the last block opens a new one to type in; Return starts the next", async () => {
  const { app, fake } = await start("/artifacts/art-mine");
  await app.waitUntil(() => app.count("id:artifact-block") === 3);
  await app.press("id:artifact-append");
  await fake.pump(app);
  expect(app.count("id:artifact-block")).toBe(4);
  expect(app.count("id:artifact-block-field")).toBe(1);
  await app.type("id:artifact-block-field", "签好版本号");
  await app.waitUntil(() => fake.calls.some((c) => c.op === "artifact.submit"), { timeout: 5000 });
  await fake.pump(app);
  expect(app.count("id:artifact-block-field")).toBe(1);
});
