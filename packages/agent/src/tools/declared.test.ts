import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { testClock } from "../testing/testing.ts";
import { codingTools } from "./coding.ts";
import { makeReminders } from "./reminders.ts";
import { selfTools, subagentTool } from "./self.ts";
import { memoryStore } from "./todoStore.ts";
import { todoTools } from "./todoTools.ts";

// The model is shown these bytes, and they lead every request. look at the diff).
const file = join(import.meta.dirname, "..", "testdata", "declared.json");
const update = process.env.VIBEVALLEY_GOLDEN === "update";

test("the brain's tools are declared to the model as they always were", async () => {
  const clock = testClock(1798758000000);
  const dir = tempDir("vibevalley-declared-");
  try {
    const reminders = await makeReminders(dir, () => undefined, { clock });
    const sets = {
      coding: codingTools({ cwd: dir }),
      self: selfTools({ now: () => clock.now(), home: dir, skills: async () => [], memory: true }),
      subagent: [subagentTool(async () => "")],
      reminders: reminders.tools,
      tasks: todoTools(memoryStore(), true, async () => undefined),
      "tasks on its own": todoTools(memoryStore(), false, async () => undefined),
    };
    const declared = Object.fromEntries(
      Object.entries(sets).map(([set, tools]) => [
        set,
        tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) })),
      ]),
    );
    if (update) writeFileSync(file, JSON.stringify(declared, undefined, 1) + "\n");
    expect(declared).toEqual(JSON.parse(readFileSync(file, "utf8")));
    await reminders.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
