import type { Page } from "@playwright/test";
import { type Agent, pathOf, type VibeValleyApi } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.use({ farm: "farm-actions" });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

const scripted: Agent = {
  id: "",
  name: "阿狐",
  role: "",
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
  const issue = await api.issue.create({ title: "提交打卡页", assignee: fox.id, project });
  await api.issue.status.update({ id: issue.id, status: "todo" });
  await handedBack(api, issue.id, 20_000);
  return issue.id;
}

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
  const review = page.getByRole("dialog", { name: "收获阿狐的地" });
  const take = review.getByRole("button", { name: /确认收获/ });
  await expect(take).toBeVisible();
  await api.issue.comment.create({ id, text: "发呆后检查一下" });
  await expect(take).toHaveCount(0);
  await expect(review).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("farm-another-round.png") });
  await handedBack(api, id);
  await expect(take).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("farm-harvest.png") });
  const harvest = page.waitForRequest(
    (r) => r.url().endsWith(pathOf("issue.status.update")) && r.postDataJSON()?.id === id && r.postDataJSON()?.status === "done",
  );
  await take.click();
  await harvest;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("done");
});

test("the workbench close dialog only offers the issue's current buttons and closes by moving it to canceled", async ({ page, api }) => {
  const id = await handBack(api, "close-accept");
  await page.goto(`/issues/${id}`);
  const detail = page.getByRole("dialog", { name: "工单", exact: true });
  await detail.getByRole("button", { name: "取消", exact: true }).click();
  const closing = page.getByRole("dialog", { name: /^关上「/ });
  await expect(closing).toBeVisible();
  const complete = closing.getByRole("button", { name: "看改动，完成" });
  await expect(complete).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("close-handed-back.png") });
  await api.issue.comment.create({ id, text: "发呆后再看看" });
  await expect(complete).toHaveCount(0);
  await handedBack(api, id);
  await expect(complete).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("close-handed-back-narrow.png") });
  const close = page.waitForRequest(
    (r) => r.url().endsWith(pathOf("issue.status.update")) && r.postDataJSON()?.id === id && r.postDataJSON()?.status === "canceled",
  );
  await closing.getByRole("button", { name: "取消工单" }).click();
  await close;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("canceled");
});

test("the workbench completion withdraws completing while another round is worked", async ({ page, api }) => {
  const id = await handBack(api, "review-accept");
  await page.goto(`/issues/${id}`);
  const detail = page.getByRole("dialog", { name: "工单", exact: true });
  await detail.getByRole("button", { name: "完成", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^关上「/ });
  const take = review.getByRole("button", { name: /^完成，合进/ });
  await expect(take).toBeVisible();
  await api.issue.comment.create({ id, text: "发呆后再检查" });
  await expect(take).toHaveCount(0);
  await expect(review).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("workbench-another-round.png") });
  await handedBack(api, id);
  await expect(take).toBeVisible();
  const completed = page.waitForRequest(
    (r) => r.url().endsWith(pathOf("issue.status.update")) && r.postDataJSON()?.id === id && r.postDataJSON()?.status === "done",
  );
  await take.click();
  await completed;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("done");
});
