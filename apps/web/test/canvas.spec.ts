import AxeBuilder from "@axe-core/playwright";

import { choose, expect, test } from "./fixtures";

test.use({ farm: "canvas" });

const poster = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canvas Poster</title></head><body>
<vv-assets><svg id="hero-art" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="#4d7a2a" /></svg></vv-assets>
<vv-board width="1200" height="800" palette="workbench">
  <vv-layer id="headline" name="Headline" x="80" y="60" w="600" h="120"><h1 style="margin:0;font-size:48px;line-height:1.2">Harvest Poster</h1><p style="margin:0;font-size:18px;line-height:1.3">Local worktrees</p></vv-layer>
  <vv-layer id="hero" name="Hero" x="80" y="220" w="260" h="260" asset="hero-art"></vv-layer>
  <vv-layer id="caption" name="Caption" x="280" y="320" w="400" h="80"><p style="margin:0;font-size:24px;line-height:1.3">Fresh from the valley</p></vv-layer>
</vv-board>
</body></html>`;

test("canvas inspector edits layers, numeric properties, effects, multi-span text, and layout flow cleanly with WCAG 2.0 AA", async ({ page, api }) => {
  const made = await api.artifact.create({ title: "Harvest Poster", kind: "html", display: "canvas", content: poster });
  expect(made.display).toBe("canvas");

  await page.goto(`/artifacts/${made.id}`);
  const artifact = page.getByTestId("artifact");
  const controls = page.getByTestId("canvas-controls");
  const lint = page.getByTestId("canvas-lint");
  const autofix = page.getByTestId("canvas-autofix");
  const railTabs = page.getByTestId("artifact-rail-tabs");

  await expect(artifact).toHaveAttribute("data-version", "1");
  await expect(controls).toBeVisible();
  await expect(railTabs).toBeVisible();
  await expect(controls).toHaveAttribute("data-palette", "workbench");
  await expect(lint).toHaveAttribute("data-issues", "1");
  await expect(autofix).toBeVisible();

  await autofix.click();
  await expect(lint).toHaveAttribute("data-issues", "0");
  await expect(page.getByTestId("canvas-reset")).toBeVisible();
  await expect(page.getByTestId("canvas-save")).toBeVisible();

  const heroRow = page.locator('[data-testid="canvas-layer"][data-layer-id="hero"]');
  await heroRow.click();
  await expect(controls).toHaveAttribute("data-selected", "hero");
  await expect(heroRow).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("canvas-flip-x").click();
  await expect(page.getByTestId("canvas-flip-x")).toHaveAttribute("aria-pressed", "true");

  await choose(page.getByTestId("canvas-filter"), "sticker-cutout");

  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(frame.locator("vv-layer#hero")).toHaveAttribute("flip", "x");
  await expect(frame.locator("vv-layer#hero")).toHaveAttribute("filter", "sticker-cutout");

  const headlineRow = page.locator('[data-testid="canvas-layer"][data-layer-id="headline"]');
  await headlineRow.click();
  await expect(controls).toHaveAttribute("data-selected", "headline");
  await expect(page.getByTestId("canvas-inspector-selected")).toHaveAttribute("data-layer-id", "headline");
  const propX = page.getByTestId("canvas-prop-x");
  await propX.fill("120");
  await propX.press("Enter");
  await expect(frame.locator("vv-layer#headline")).toHaveAttribute("x", "120");
  const layerText = page.getByTestId("canvas-layer-text");
  await expect(layerText).toHaveValue("Harvest Poster\nLocal worktrees");
  await layerText.fill("Autumn Fair\nField notes");
  await expect(frame.locator("vv-layer#headline h1")).toHaveText("Autumn Fair");
  await expect(frame.locator("vv-layer#headline p")).toHaveText("Field notes");

  await choose(page.getByTestId("canvas-palette"), "brutalist-red");
  await expect(controls).toHaveAttribute("data-palette", "brutalist-red");

  await railTabs.locator('[data-key="talk"]').click();
  await expect(page.getByTestId("artifact-chat-pane")).toBeVisible();
  await expect(page.getByTestId("artifact-chat-pane").getByTestId("composer-input")).toBeVisible();
  await railTabs.locator('[data-key="inspect"]').click();
  await expect(page.getByTestId("canvas-layers")).toBeVisible();

  const listToggle = page.getByTestId("artifact-list-toggle");
  await listToggle.click();
  await expect(page.getByTestId("artifact-list")).toBeHidden();
  await listToggle.click();
  await expect(page.getByTestId("artifact-list")).toBeVisible();

  const editingAxe = await new AxeBuilder({ page }).exclude('[data-testid="artifact-frame"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(editingAxe.violations).toEqual([]);

  await page.getByTestId("canvas-save").click();
  await expect(artifact).toHaveAttribute("data-version", "2");
  await expect(controls).toHaveAttribute("data-palette", "brutalist-red");
  await expect(lint).toHaveAttribute("data-issues", "0");
  await expect(page.getByTestId("canvas-save")).toBeHidden();
  await expect(frame.locator("vv-layer#hero")).toHaveAttribute("flip", "x");
  await expect(frame.locator("vv-layer#hero")).toHaveAttribute("filter", "sticker-cutout");
  await expect(frame.locator("vv-layer#headline h1")).toHaveText("Autumn Fair");
  await expect(frame.locator("vv-layer#headline p")).toHaveText("Field notes");

  const saved = await api.artifact.content.get({ id: made.id, version: 2 });
  expect(saved.content).toContain('palette="brutalist-red"');
  expect(saved.content).toContain('flip="x"');
  expect(saved.content).toContain('x="120"');
  expect(saved.content).toContain('filter="sticker-cutout"');
  expect(saved.content).toContain("Autumn Fair");
  expect(saved.content).toContain("Field notes");

  await expect(page.getByTestId("toast")).toHaveCSS("opacity", "1");
  const savedAxe = await new AxeBuilder({ page }).exclude('[data-testid="artifact-frame"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(savedAxe.violations).toEqual([]);
});

test("unified library discovers .whiteboard and compound deliverables, filters them, and opens whiteboard connectors", async ({ page, api }) => {
  const wb = await api.artifact.create({
    title: "architecture.whiteboard",
    kind: "html",
    content: JSON.stringify({
      palette: "workbench",
      nodes: [
        { id: "web", label: "Web UI", x: 100, y: 140 },
        { id: "server", label: "Server API", x: 520, y: 140, tone: "accent" },
      ],
      edges: [{ from: "web", to: "server", label: "SSE" }],
    }),
  });
  expect(wb.display).toBe("whiteboard");

  await page.goto("/library");
  const rail = page.getByTestId("library-rail");
  await rail.locator('[data-testid="library-artifact-kind"][data-kind="whiteboard"]').click();

  const tile = page.locator(`[data-testid="library-artifact-item"][data-key="${wb.id}"]`);
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId("library-artifact-suffix")).toHaveText(".whiteboard");

  await tile.click();
  const inspector = page.getByTestId("library-inspector");
  await expect(inspector.getByTestId("library-inspector-name")).toHaveText("architecture.whiteboard");
  await inspector.getByTestId("library-open-artifact").click();

  await expect(page).toHaveURL(new RegExp(`/artifacts/${wb.id}$`, "u"));
  await expect(page.getByTestId("artifact-back-library")).toBeVisible();
  await expect(page.getByTestId("artifact-suffix")).toHaveText(".whiteboard");

  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(frame.locator("vv-layer#web")).toBeVisible();
  await expect(frame.locator("vv-layer#server")).toBeVisible();
  await expect(frame.locator("svg.vv-edges path")).toHaveCount(2);
});
