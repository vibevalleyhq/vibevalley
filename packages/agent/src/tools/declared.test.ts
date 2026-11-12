import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { selfTools, subagentTool } from "./self.ts";
import { memoryStore } from "./todoStore.ts";
import { todoTools } from "./todoTools.ts";

// The model is shown these bytes, and they lead every request.
const file = join(import.meta.dirname, "..", "testdata", "declared.json");
const update = process.env.VIBEVALLEY_GOLDEN === "update";

test("the agent's own tools are declared to the model as they always were", async () => {
  const dir = tempDir("vibevalley-declared-");
  try {
    const sets = {
      self: selfTools({ now: () => 1798758000000, home: dir, skills: async () => [], memory: true }),
      subagent: [subagentTool(async () => "")],
      "tasks on its own": todoTools(memoryStore(), async () => undefined),
    };
    const declared = Object.fromEntries(
      Object.entries(sets).map(([set, tools]) => [
        set,
        tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) })),
      ]),
    );
    if (update) writeFileSync(file, JSON.stringify(declared, undefined, 1) + "\n");
    expect(declared).toEqual(JSON.parse(readFileSync(file, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
