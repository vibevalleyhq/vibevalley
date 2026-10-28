import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

// A server of its own: installing and adding templates changes the whole farm's profiles.
test.use({ farm: "templates" });

test("a template is looked at, installed again, added from a folder, and its newer version taken when asked", async ({ page, api, server }) => {
  await page.goto("/agents");
  await page.getByTestId("open-templates").click();
  await expect(page).toHaveURL(/\/agents\/templates$/);

  // The test farm starts with every built-in template installed once.
  const backend = page.locator('[data-testid="template"][data-key="backend"]');
  await expect(backend).toHaveAttribute("data-installed", "1");
  await backend.getByTestId("template-look").click();
  await expect(backend.getByTestId("template-persona")).not.toBeEmpty();
  await backend.getByTestId("template-install").click();
  await expect(page).toHaveURL(/\/agents\/backend-2$/);
  const from = page.getByTestId("from-template");
  await expect(from).toHaveAttribute("data-key", "backend");
  await expect(from).toHaveAttribute("data-version", "1");

  // A folder on this machine: added beside the built-in ones, then installed as a new orchestrator.
  const folder = join(server.work, "lead-template");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "agent.json"), JSON.stringify({ id: "lead", version: 1, role: "orchestrator", name: "front lead", duty: "front end" }));
  writeFileSync(join(folder, "persona.md"), "You own the front end's issues.\n");
  await page.goto("/agents/templates");
  await page.getByTestId("template-folder").fill(folder);
  await page.getByTestId("template-add").click();
  const lead = page.locator('[data-testid="template"][data-key="lead"]');
  await expect(lead).toHaveAttribute("data-source", "added");
  await lead.getByTestId("template-install").click();
  await expect(page).toHaveURL(/\/agents\/lead$/);
  expect((await api.agent.list()).find((a) => a.id === "lead")?.role).toBe("orchestrator");

  // The template moves on: the profile says so, and only taking it changes the profile.
  writeFileSync(
    join(server.home, "agent-templates", "lead", "agent.json"),
    JSON.stringify({ id: "lead", version: 2, role: "orchestrator", name: "front lead", duty: "front end and designs" }),
  );
  await page.reload();
  await page.getByTestId("template-update").click();
  await page.getByTestId("template-update-sure").click();
  await expect(page.getByTestId("from-template")).toHaveAttribute("data-version", "2");
  expect((await api.agent.list()).find((a) => a.id === "lead")?.duty).toBe("front end and designs");
});
