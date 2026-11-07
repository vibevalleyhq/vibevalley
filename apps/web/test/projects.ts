import { join } from "node:path";

import { defineConfig } from "@playwright/test";

export const suites = {
  component: { artifact: "stories", testMatch: ["**/stories.spec.ts"], testIgnore: [] },
  integration: {
    artifact: "app",
    testMatch: ["**/*.spec.ts"],
    testIgnore: ["**/stories.spec.ts", "**/stories-a11y.spec.ts", "**/a11y.spec.ts", "**/layout-a11y.spec.ts", "**/farm-visual.spec.ts"],
  },
  "audit-stories": { artifact: "stories", testMatch: ["**/stories-a11y.spec.ts"], testIgnore: [] },
  "audit-pages": { artifact: "app", testMatch: ["**/a11y.spec.ts", "**/layout-a11y.spec.ts"], testIgnore: [] },
  visual: { artifact: "app", testMatch: ["**/farm-visual.spec.ts"], testIgnore: [] },
} as const;
type Suite = keyof typeof suites;
const isSuite = (name: string): name is Suite => Object.hasOwn(suites, name);

export function artifactsFor(names: readonly string[]) {
  return [
    ...new Set(
      names.map((name) => {
        if (!isSuite(name)) throw new Error(`Unknown browser suite: ${name}. Fix: use a suite from test/projects.ts.`);
        return suites[name].artifact;
      }),
    ),
  ];
}

export function browserConfig(names: readonly Suite[]) {
  return defineConfig({
    testDir: import.meta.dirname,
    timeout: 60_000,
    outputDir: join(import.meta.dirname, "../test-results"),
    reporter: [["list"], [join(import.meta.dirname, "budgets.ts")]],
    globalSetup: join(import.meta.dirname, "global-setup.ts"),
    use: { viewport: { width: 1280, height: 800 }, locale: "zh-CN", trace: process.env.CI ? "retain-on-failure" : "off" },
    projects: names.map((name) => ({
      name,
      fullyParallel: name === "audit-stories",
      testMatch: [...suites[name].testMatch],
      testIgnore: [...suites[name].testIgnore],
    })),
  });
}
