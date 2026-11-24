import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { fakeHost } from "../../app/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

async function mountMemory(configure?: (fake: ReturnType<typeof fakeHost>) => void) {
  const fake = fakeHost(scenarios.typical, { route: "/orchestrator/memory" });
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:note-input") === 1);
  return { app, fake };
}

test("WriteNote clears optimistically on submit and restores failed draft only when still empty", async () => {
  let allowCreate = false;
  const { app, fake } = await mountMemory((f) => {
    const base = scenarios.typical.responses["memory.create"];
    f.respond("memory.create", () => (allowCreate ? base : { bizCode: 300001, message: "Memory service unavailable" }));
  });

  await app.type("id:note-input", "Remember branch naming convention");
  expect(app.enabled("id:note-write")).toBe(true);
  await app.press("id:note-write");

  // Optimistic clear happens before the RPC reply is pumped.
  expect(app.value("id:note-input")).toBe("");
  expect(fake.calls.some((c) => c.op === "memory.create")).toBe(true);

  // Failure with empty input restores the failed note draft.
  await fake.pumpUntil(app, () => app.count("id:note-error") === 1);
  expect(app.value("id:note-input")).toBe("Remember branch naming convention");

  // Mid-flight replacement text must not be clobbered if the failed RPC settles later.
  fake.clearCalls();
  await app.press("id:note-write");
  expect(app.value("id:note-input")).toBe("");
  await app.type("id:note-input", "Replacement note typed mid-flight");
  await fake.pumpUntil(app, () => app.count("id:note-error") === 1);
  expect(app.value("id:note-input")).toBe("Replacement note typed mid-flight");

  // Subsequent accepted submission keeps the input cleared.
  allowCreate = true;
  fake.clearCalls();
  await app.press("id:note-write");
  expect(app.value("id:note-input")).toBe("");
  await fake.pump(app);
  expect(app.value("id:note-input")).toBe("");
  expect(fake.calls.filter((c) => c.op === "memory.create").length).toBe(1);
});
