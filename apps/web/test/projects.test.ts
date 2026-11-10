import { readdirSync } from "node:fs";
import { matchesGlob } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import component from "../playwright.component.config";
import all from "../playwright.config";
import { artifactsFor, suites } from "./projects";

describe("browser test boundaries", () => {
  it("regression: every spec belongs to exactly one suite, including visual captures", () => {
    const files = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".spec.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const users = Object.entries(suites)
        .filter(([, suite]) => suite.testMatch.some((pattern) => matchesGlob(file, pattern)) && !suite.testIgnore.some((pattern) => matchesGlob(file, pattern)))
        .map(([name]) => name);
      expect(users, `${file}: Fix: give each browser spec one user in test/projects.ts.`).toHaveLength(1);
    }
  });

  it("builds only the artifacts used by the selected entry point", () => {
    expect(artifactsFor(["component"])).toEqual(["stories"]);
    expect(artifactsFor(["integration"])).toEqual(["app"]);
    expect(artifactsFor(["visual"])).toEqual(["app"]);
    expect(artifactsFor(["audit-stories", "audit-pages"])).toEqual(["stories", "app"]);
    expect(artifactsFor(["component", "integration", "audit-stories", "audit-pages"])).toEqual(["stories", "app"]);
    expect(() => artifactsFor(["unknown"])).toThrow("Unknown browser suite");
  });

  it("separates full automated checks from visual captures without dropping audits", () => {
    expect(all.projects?.map((project) => project.name)).toEqual(["component", "integration", "audit-stories", "audit-pages"]);
    expect(component.projects?.map((project) => project.name)).toEqual(["component"]);
    expect(all.projects?.filter((project) => project.fullyParallel === true).map((project) => project.name)).toEqual(["audit-stories"]);
  });
});
