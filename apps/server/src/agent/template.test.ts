import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { setLocale } from "@vibevalley/i18n";
import { defaultOrchestrator, orchestratorRuntime } from "@vibevalley/protocol";

import { builtInDir, builtInIds, builtInTemplates, readTemplate } from "./template.ts";

describe("the built-in templates", () => {
  it.effect("are every folder, listed once, each under its own id", () =>
    Effect.gen(function* () {
      const folders = readdirSync(builtInDir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [d.name] : []));
      const ids = yield* builtInIds;
      expect([...ids].toSorted()).toEqual(folders.toSorted());
      expect(new Set(ids).size).toBe(ids.length);
      for (const t of yield* builtInTemplates) expect(t.id).toBe((yield* readTemplate(join(builtInDir, t.id), "builtIn")).id);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("start with the default orchestrator, on VibeValley's own agent; the rest are workers", () =>
    Effect.gen(function* () {
      const [first, ...rest] = yield* builtInTemplates;
      expect([first!.id, first!.role, first!.runtime]).toEqual([defaultOrchestrator, "orchestrator", orchestratorRuntime]);
      expect(rest.every((t) => t.role === "helper" && t.runtime !== "")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("say the same in English, in English words", () =>
    Effect.gen(function* () {
      const han = /\p{Script=Han}/u;
      for (const id of yield* builtInIds) {
        expect(existsSync(join(builtInDir, id, "agent.en.json"))).toBe(true);
        const persona = join(builtInDir, id, "persona.md");
        if (existsSync(persona)) expect(readFileSync(join(builtInDir, id, "persona.en.md"), "utf8")).not.toMatch(han);
      }
      setLocale("en");
      const english = yield* Effect.ensuring(
        builtInTemplates,
        Effect.sync(() => setLocale("zh")),
      );
      for (const t of english) expect(JSON.stringify([t.name, t.duty, t.tags, t.persona])).not.toMatch(han);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
