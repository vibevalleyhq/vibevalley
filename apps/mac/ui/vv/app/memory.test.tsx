// The memory panels (a helper's config tab, the orchestrator's page) and the
// orchestrator's voice tab, with fakeHost playing the Rust side
// (fixtures/memory.ts, the workbench's settings).
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(route: string) {
  const fake = fakeHost({ state, responses }, { route });
  const app = await open("./main.tsx", { width: 1200, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await fake.pump(app);
  return { app, fake };
}

test("a helper's memory: what it did, the next recall, notes filtered by repo", async () => {
  const { app, fake } = await start("/agents/laozhou");
  await app.press("id:tab-memory");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:memory-panel")).toBe(1);
  expect(app.count("id:memory-sources")).toBe(1);
  expect(app.count("id:memory-issues")).toBe(1);
  expect(app.count("id:recall-lines")).toBe(1);
  expect(fake.calls.find((c) => c.op === "memory.recall")?.payload).toEqual({ agent: "laozhou", repo: "vibevalley", text: "" });
  for (const id of ["m-note-1", "m-note-2", "m-note-3", "m-note-4"]) expect(app.count(`id:memory-${id}`)).toBe(1);
  await app.press("id:memory-repo-*");
  expect(app.count("id:memory-m-note-3")).toBe(1);
  expect(app.count("id:memory-m-note-1")).toBe(0);
  await app.press("id:memory-repo-vibevalley");
  expect(app.count("id:memory-m-note-4")).toBe(1);
  // From a source that keeps its own: no forgetting here.
  expect(app.count("id:memory-m-note-4 >> id:forget")).toBe(0);
});

test("writing a note with its repo, forgetting one", async () => {
  const { app, fake } = await start("/agents/laozhou");
  await app.press("id:tab-memory");
  await fake.pump(app);
  expect(app.enabled("id:note-write")).toBe(false);
  await app.type("id:note-input", "先跑测试再提交");
  await app.type("id:note-repo", "vibe");
  expect(app.count("id:note-repo-vibevalley")).toBe(1);
  await app.type("id:note-repo", "valley");
  await app.press("id:note-write");
  await fake.pump(app);
  const created = fake.calls.find((c) => c.op === "memory.create")?.payload as Record<string, unknown>;
  expect(created.agent).toBe("laozhou");
  expect(created.text).toBe("先跑测试再提交");
  expect(created.repo).toBe("vibevalley");
  expect(app.value("id:note-input")).toBe("");
  await app.hover("id:memory-m-note-1");
  await app.press("id:memory-m-note-1 >> id:forget");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "memory.delete")?.payload).toEqual({ agent: "laozhou", memory: "m-note-1" });
});

test("the orchestrator's memory and its voice: persona, greeting, a MiniMax voice's sample", async () => {
  const { app, fake } = await start("/orchestrator");
  expect(app.count("id:orchestrator-memory")).toBe(1);
  expect(app.count("id:notes")).toBe(1);
  await app.press("id:tab-voice");
  await fake.pump(app);
  expect(app.count("id:greeting")).toBe(1);
  expect(app.count("id:voice-tts")).toBe(1);
  expect(app.count("id:minimax-voices")).toBe(1);
  await app.press("id:voice-sample-female-shaonv");
  expect(app.audio().some((a) => a.src.includes("female-shaonv"))).toBe(true);
  await app.press("id:voice-pick-female-yujie");
  expect(app.count("id:save-bar-dirty")).toBe(1);
});
