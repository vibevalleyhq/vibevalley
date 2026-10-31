import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { tempDir } from "@vibevalley/testkit/temp";

import { codingTools } from "./coding.ts";
import { makeReminders } from "./reminders.ts";
import { selfTools, subagentTool } from "./self.ts";
import { memoryStore } from "./todoStore.ts";
import { todoTools } from "./todoTools.ts";

// The model is shown these bytes, and they lead every request: a change here is a change in the prompt, made on purpose
// (VIBEVALLEY_GOLDEN=update rewrites testdata/declared.json; look at the diff).
const file = join(import.meta.dirname, "testdata", "declared.json");
const update = process.env.VIBEVALLEY_GOLDEN === "update";

it.effect("the brain's tools are declared to the model as they always were", () =>
  Effect.gen(function* () {
    const dir = tempDir("vibevalley-declared-");
    try {
      const reminders = yield* makeReminders(dir, Date.now, () => Effect.void);
      const sets = {
        coding: codingTools({ cwd: dir }),
        self: selfTools({ now: Date.now, home: dir, skills: async () => [], memory: true }),
        subagent: [subagentTool(() => Effect.succeed(""))],
        reminders: reminders.tools,
        tasks: todoTools(memoryStore(), true, Effect.void),
        "tasks on its own": todoTools(memoryStore(), false, Effect.void),
      };
      const declared = Object.fromEntries(
        Object.entries(sets).map(([set, tools]) => [
          set,
          tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) })),
        ]),
      );
      if (update) writeFileSync(file, JSON.stringify(declared, null, 1) + "\n");
      expect(declared).toEqual(JSON.parse(readFileSync(file, "utf8")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);
