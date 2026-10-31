import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { setLocale } from "@vibevalley/i18n";
import { defaultOrchestrator, orchestratorRuntime } from "@vibevalley/protocol";

import { builtInDir, builtInIds, builtInTemplates, readTemplate } from "./template.ts";

describe("the built-in templates", () => {
  it("are every folder, listed once, each under its own id", () => {
    const folders = readdirSync(builtInDir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [d.name] : []));
    expect([...builtInIds()].toSorted()).toEqual(folders.toSorted());
    expect(new Set(builtInIds()).size).toBe(builtInIds().length);
    for (const t of builtInTemplates()) expect(t.id).toBe(readTemplate(join(builtInDir, t.id), "builtIn").id);
  });

  it("start with the default orchestrator, on VibeValley's own agent; the rest are workers", () => {
    const [first, ...rest] = builtInTemplates();
    expect([first!.id, first!.role, first!.runtime]).toEqual([defaultOrchestrator, "orchestrator", orchestratorRuntime]);
    expect(rest.every((t) => t.role === "helper" && t.runtime !== "")).toBe(true);
  });

  it("say the same in English, in English words", () => {
    const han = /\p{Script=Han}/u;
    for (const id of builtInIds()) {
      expect(existsSync(join(builtInDir, id, "agent.en.json"))).toBe(true);
      const persona = join(builtInDir, id, "persona.md");
      if (existsSync(persona)) expect(readFileSync(join(builtInDir, id, "persona.en.md"), "utf8")).not.toMatch(han);
    }
    setLocale("en");
    try {
      for (const t of builtInTemplates()) expect(JSON.stringify([t.name, t.duty, t.tags, t.persona])).not.toMatch(han);
    } finally {
      setLocale("zh");
    }
  });
});
