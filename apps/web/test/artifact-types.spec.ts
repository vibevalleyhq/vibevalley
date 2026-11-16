import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { artifactId } from "@vibevalley/protocol/schema";

import { composerOn, expect, test } from "./fixtures";

test.use({ farm: "artifact-types" });

async function pickNewType(page: Page, key: string) {
  await page.goto("/artifacts");
  await page.getByTestId("new-artifact-type").click();
  await page.locator(`[role="menuitem"][data-key="${key}"]`).click();
}

test("creates a dashboard from the type picker, verifies data-source provenance, and opens dataset sources", async ({ page }) => {
  await pickNewType(page, "dashboard");

  await expect(page.getByTestId("dashboard-view")).toBeVisible();
  await expect(page.getByTestId("dashboard-provenance-badge")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("dashboard-sources-toggle").click();
  const sources = page.getByTestId("dashboard-sources");
  await expect(sources).toBeVisible();
  await expect(sources.getByTestId("dashboard-dataset-tab")).toHaveCount(1);

  const { violations } = await new AxeBuilder({ page }).exclude('[data-testid="dashboard-frame"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("whiteboard renders elements and arrows, places shapes, edits labels, and deletes selected nodes", async ({ page }) => {
  await pickNewType(page, "whiteboard");

  await expect(page.getByTestId("whiteboard-view")).toBeVisible();
  await expect(page.getByTestId("wb-node")).toHaveCount(2);
  await expect(page.getByTestId("wb-arrow")).toHaveCount(1);

  await page.getByTestId("wb-tool-rect").click();
  await page.getByTestId("whiteboard-canvas").click({ position: { x: 420, y: 260 } });
  await expect(page.getByTestId("wb-node")).toHaveCount(3);

  const firstNode = page.locator('[data-testid="wb-node"][data-key="node-1"]');
  await firstNode.dblclick();
  const input = page.getByTestId("wb-label-input");
  await expect(input).toBeVisible();
  await input.fill("Gateway API");
  await input.press("Enter");
  await expect(firstNode).toContainText("Gateway API");

  await firstNode.click();
  await page.getByTestId("wb-delete").click();
  await expect(page.getByTestId("wb-node")).toHaveCount(2);
});

test("design-system sets standing default and checks contrast; design canvas edits and persists data-props", async ({ page, api }) => {
  await pickNewType(page, "design-system");

  await expect(page.getByTestId("design-system-view")).toBeVisible();
  await page.getByTestId("ds-toggle-default").click();
  await expect(page.getByTestId("ds-default-badge")).toBeVisible();

  await page.locator('[role="tab"][data-key="colors"]').click();
  await expect(page.getByTestId("ds-color-swatch").first()).toBeVisible();
  await expect(page.getByTestId("ds-contrast-badge").first()).toBeVisible();

  await pickNewType(page, "design");
  await expect(page.getByTestId("design-canvas-view")).toBeVisible();
  const designId = page.url().split("/artifacts/")[1]?.split("?")[0] ?? "";
  expect(designId).not.toBe("");

  const ctaControl = page.locator('[data-testid="design-prop-control"][data-key="cta"] input');
  await expect(ctaControl).toBeVisible({ timeout: 10_000 });
  await ctaControl.fill("Autumn Release");
  await page.getByTestId("design-save-props").click();

  await expect
    .poll(async () => (await api.artifact.entry.get({ id: artifactId(designId), path: "project/desktop.dc.html" })).value ?? "")
    .toContain("Autumn Release");
});

test("structured slides and motion viewers report active viewContext when chatting beside an open artifact", async ({ page, api }) => {
  await pickNewType(page, "slides");
  await expect(page.getByTestId("slides-store-view")).toBeVisible();
  await expect(page.getByTestId("slides-at")).toContainText("1 / 2");
  await page.getByTestId("slides-add").click();
  await expect(page.getByTestId("slides-at")).toContainText("/ 3");

  await pickNewType(page, "motion");
  await expect(page.getByTestId("motion-store-view")).toBeVisible();
  const filmId = page.url().split("/artifacts/")[1]?.split("?")[0] ?? "";
  expect(filmId).not.toBe("");

  const general = (await api.channel.list()).find((c) => c.default)!;
  await page.goto(`/chat/${general.id}?artifact=${filmId}`);
  await expect(page.getByTestId("artifact-canvas")).toBeVisible();
  await expect(page.getByTestId("motion-controls")).toBeVisible();
  await expect(page.getByTestId("motion-chapter")).toHaveCount(2);

  await page.getByTestId("motion-chapter").nth(1).click();
  await expect(page.getByTestId("motion-time")).toContainText("2.00s");

  const input = await composerOn(page, general.id);
  await input.fill("Slow down this transition");
  await input.press("Enter");

  await expect
    .poll(async () => {
      const msgs = await api.channel.message.list({ id: general.id });
      return msgs.find((m) => m.text === "Slow down this transition")?.viewContext;
    })
    .toMatchObject({
      artifactId: filmId,
      artifactType: "motion",
      time: 2,
    });
});
