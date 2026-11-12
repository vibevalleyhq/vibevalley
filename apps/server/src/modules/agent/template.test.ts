import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { setLocale } from "@vibevalley/i18n";
import { defaultOrchestrator, orchestratorRuntime } from "@vibevalley/protocol";

import { builtInDir, builtInIds, builtInTemplates, readTemplate } from "./template.ts";

describe("the built-in templates", () => {
  test("are every folder, listed once, each under its own id", async () => {
    const folders = readdirSync(builtInDir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [d.name] : []));
    const ids = await builtInIds();
    expect([...ids].toSorted()).toEqual(folders.toSorted());
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of await builtInTemplates()) expect(t.id).toBe((await readTemplate(join(builtInDir, t.id), "builtIn")).id);
  });

  test("start with the default orchestrator, on VibeValley's own agent; the rest are workers", async () => {
    const [first, ...rest] = await builtInTemplates();
    expect([first!.id, first!.role, first!.runtime]).toEqual([defaultOrchestrator, "orchestrator", orchestratorRuntime]);
    expect(rest.every((t) => t.role === "worker" && t.runtime !== "")).toBe(true);
  });

  test("say the same in English, in English words", async () => {
    const han = /\p{Script=Han}/u;
    for (const id of await builtInIds()) {
      expect(existsSync(join(builtInDir, id, "agent.en.json"))).toBe(true);
      const persona = join(builtInDir, id, "persona.md");
      if (existsSync(persona)) expect(readFileSync(join(builtInDir, id, "persona.en.md"), "utf8")).not.toMatch(han);
    }
    setLocale("en");
    let english;
    try {
      english = await builtInTemplates();
    } finally {
      setLocale("zh");
    }
    for (const t of english) expect(JSON.stringify([t.name, t.duty, t.tags, t.persona])).not.toMatch(han);
  });
});
