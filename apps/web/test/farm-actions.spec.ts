import type { Page } from "@playwright/test";
import { type Agent, pathOf, type VibeValleyApi } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.use({ farm: "farm-actions" });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

const scripted: Agent = {
  id: "",
  name: "fox",
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: { species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
};

async function handBack(api: VibeValleyApi, project: string) {
  const fox = await api.agent.create(scripted);
  await api.project.create({ name: project });
  const issue = await api.issue.create({ title: commits, assignee: fox.id, project });
  await api.issue.status.update({ id: issue.id, status: "todo" });
  await handedBack(api, issue.id, 20_000);
  return issue.id;
}

// The test helper commits a change on 提交 (apps/server/src/testing/helper.ts), so the review has files.
const commits = "提交打卡页";

// The test helper idles on 发呆 until it is told again (apps/server/src/testing/helper.ts): another round is being worked.
const anotherRound = "发呆 then check it";

const handedBack = (api: VibeValleyApi, id: string, timeout?: number) =>
  expect.poll(async () => (await api.issue.get({ id })).attention.acts.map((a) => a.act), timeout ? { timeout } : {}).toContain("complete");

async function bed(page: Page) {
  const canvas = page.getByTestId("village").locator("canvas");
  const box = (await canvas.boundingBox())!;
  const scale = box.width / 384;
  return { x: box.x + 128 * scale, y: box.y + 117 * scale };
}

test("the harvest tool and its open confirmation follow the latest issue", async ({ page, api }) => {
  const id = await handBack(api, "farm-accept");
  await page.goto("/farm/farm-accept");
  const village = page.getByTestId("village");
  await expect(village).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const soil = await bed(page);
  await page.keyboard.press("5");
  await page.mouse.move(soil.x, soil.y);
  await expect(village).toHaveCSS("cursor", /harvest-ok/);
  await page.mouse.click(soil.x, soil.y);
  const review = page.getByTestId("harvest");
  const take = review.locator('[data-act="complete"]');
  await expect(take).toBeVisible();
  await api.issue.comment.create({ id, text: anotherRound });
  await expect(take).toHaveCount(0);
  await expect(review).toBeVisible();
  await handedBack(api, id);
  await expect(take).toBeVisible();
  const harvest = page.waitForRequest(
    (r) => r.url().endsWith(pathOf("issue.status.update")) && r.postDataJSON()?.id === id && r.postDataJSON()?.status === "done",
  );
  await take.click();
  await harvest;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("done");
});

test("the workbench's closing offers only the issue's current acts, and completes", async ({ page, api }) => {
  const id = await handBack(api, "review-accept");
  await page.goto(`/issues/${id}`);
  await page.getByTestId("issue").locator('[data-act="complete"]').click();
  const closing = page.getByTestId("close-issue");
  const take = closing.locator('[data-act="complete"]');
  await expect(take).toBeVisible();
  await api.issue.comment.create({ id, text: anotherRound });
  await expect(take).toHaveCount(0);
  await expect(closing).toBeVisible();
  await handedBack(api, id);
  await expect(take).toBeVisible();
  const completed = page.waitForRequest(
    (r) => r.url().endsWith(pathOf("issue.status.update")) && r.postDataJSON()?.id === id && r.postDataJSON()?.status === "done",
  );
  await take.click();
  await completed;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("done");
});

test("a file's patch in the review is coloured in its language, on the palette", async ({ page, api }) => {
  const id = await handBack(api, "review-colours");
  await page.goto(`/issues/${id}`);
  await page.getByTestId("issue").locator('[data-act="complete"]').click();
  const review = page.getByTestId("close-issue");
  await review.locator('[data-testid="changed-file"][data-key$=".ts"]').first().click();
  // The keyword export comes back from the worker drawn in the palette's keyword colour.
  await expect(review.locator('span[style*="--shiki-token-keyword"]').first()).toBeVisible();
});
