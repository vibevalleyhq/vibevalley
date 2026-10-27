import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { plainLog } from "../../base/log.ts";
import { wallTime } from "../../base/time.ts";
import { memoryStore } from "./agentTaskStore.ts";
import { taskTools } from "./agentTaskTools.ts";
import { codingTools } from "./coding.ts";
import { Reminders } from "./reminders.ts";
import { selfTools, subagentTool } from "./self.ts";

// The model is shown these bytes, and they lead every request: a change here is a change in the prompt, made on purpose
// (VIBEVALLEY_GOLDEN=update rewrites testdata/declared.json; look at the diff).
const file = join(import.meta.dirname, "testdata", "declared.json");

it("the brain's tools are declared to the model as they always were", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibevalley-declared-"));
  try {
    const reminders = new Reminders(dir, () => {}, wallTime, plainLog);
    const sets = {
      coding: codingTools({ cwd: dir }),
      self: selfTools({ now: wallTime.now, home: dir, skills: () => [], memory: true }),
      subagent: [subagentTool(async () => "")],
      reminders: reminders.tools,
      tasks: taskTools(memoryStore(), true, () => {}),
      "tasks on its own": taskTools(memoryStore(), false, () => {}),
    };
    const declared = Object.fromEntries(
      Object.entries(sets).map(([set, tools]) => [
        set,
        tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) })),
      ]),
    );
    if (process.env.VIBEVALLEY_GOLDEN === "update") writeFileSync(file, JSON.stringify(declared, null, 1) + "\n");
    expect(declared).toEqual(JSON.parse(readFileSync(file, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
