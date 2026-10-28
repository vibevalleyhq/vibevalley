// Every workbench page through axe (WCAG 2 A and AA): the roles, names and contrast a page test no longer reads off the
// words it finds things by. The farm's canvas and the tree's scene are pictures, not controls, and are left to their own
// tests.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const sections = ["general", "appearance", "models", "about", "memory", "skills", "call", "moss", "dictation", "github", "chat", "devices"];

for (const theme of ["light", "dark"] as const)
  test(`no workbench page has an accessibility violation in the ${theme} theme`, async ({ page, api }) => {
    await page.addInitScript((t) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: t })), theme);
    const issue = await api.issue.create({ title: "an issue to look at" });
    const agent = (await api.agent.list()).find((a) => a.role === "worker")!;
    const paths = [
      "/chat",
      "/issues",
      `/issues/${issue.id}`,
      "/docs",
      "/agents",
      `/agents/${agent.id}`,
      "/agents/templates",
      "/orchestrator",
      "/runtimes",
      "/projects",
      "/catalog",
      ...sections.map((s) => `/settings/${s}`),
    ];
    const found: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const v of violations)
        found.push(`${path} ${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any.map((c) => c.message).join(" ")}`).join(", ")}`);
    }
    expect(found).toEqual([]);
  });
