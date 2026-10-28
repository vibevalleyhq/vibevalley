import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

// A server of its own: installing and adding templates changes the whole farm's profiles.
test.use({ farm: "templates" });

test("a template is looked at, installed again, added from a folder, and its newer version taken when asked", async ({ page, api, server }) => {
  await page.goto("/agents");
  await page.getByRole("link", { name: "从模板装" }).click();
  await expect(page).toHaveURL(/\/agents\/templates$/);
  await expect(page.getByRole("heading", { name: "模板", level: 1 })).toBeVisible();

  // The test farm starts with every built-in template installed once.
  const backend = page.getByRole("region", { name: "后端老周" });
  await expect(backend.getByText("装了 1 份")).toBeVisible();
  await backend.getByRole("button", { name: "看看" }).click();
  await expect(backend.getByText(/谨慎的后端工程师/)).toBeVisible();
  await backend.getByRole("button", { name: "装上" }).click();
  await expect(page).toHaveURL(/\/agents\/backend-2$/);
  await expect(page.getByText("来自模板「后端老周」第 1 版")).toBeVisible();

  // A folder on this machine: added beside the built-in ones, then installed as a new orchestrator.
  const folder = join(server.work, "lead-template");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "agent.json"), JSON.stringify({ id: "lead", version: 1, role: "orchestrator", name: "前端组长", duty: "专管前端" }));
  writeFileSync(join(folder, "persona.md"), "你专管前端的工单。\n");
  await page.goto("/agents/templates");
  await page.getByLabel("模板文件夹").fill(folder);
  await page.getByRole("button", { name: "加进来" }).click();
  const lead = page.getByRole("region", { name: "前端组长" });
  await expect(lead.getByText("本机加进来的")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("templates.png") });
  await lead.getByRole("button", { name: "装上" }).click();
  await expect(page).toHaveURL(/\/agents\/lead$/);
  await expect(page.getByText("管家", { exact: true }).first()).toBeVisible();
  expect((await api.agent.list()).find((a) => a.id === "lead")?.role).toBe("orchestrator");

  // The template moves on: the profile says so, and only taking it changes the profile.
  writeFileSync(
    join(server.home, "agent-templates", "lead", "agent.json"),
    JSON.stringify({ id: "lead", version: 2, role: "orchestrator", name: "前端组长", duty: "专管前端和设计稿" }),
  );
  await page.reload();
  await page.getByRole("button", { name: "照模板更新到第 2 版" }).click();
  await expect(page.getByText(/用模板的新版本盖掉/)).toBeVisible();
  await page.getByRole("button", { name: "照模板更新到第 2 版" }).click();
  await expect(page.getByText("来自模板「前端组长」第 2 版")).toBeVisible();
  expect((await api.agent.list()).find((a) => a.id === "lead")?.duty).toBe("专管前端和设计稿");
});
