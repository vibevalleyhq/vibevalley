import type { Page } from "@playwright/test";
import type { Agent, VibeValleyApi } from "@vibevalley/protocol";
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
  const fox = await api.agent.create({ body: scripted });
  await api.project.create({ body: { name: project } });
  const issue = await api.issue.create({ body: { title: "提交打卡页", assignee: fox.id, project } });
  await api.issue.update({ id: issue.id, body: { review: "required" } });
  await api.issue.act({ id: issue.id, body: { act: "start" } });
  await expect.poll(async () => (await api.issue.get({ id: issue.id })).attention.acts, { timeout: 20_000 }).toContain("accept");
  return issue.id;
}

async function bed(page: Page) {
  const canvas = page.getByTestId("village").locator("canvas");
  const box = (await canvas.boundingBox())!;
  const scale = box.width / 384;
  return { x: box.x + 128 * scale, y: box.y + 117 * scale };
}

test("the harvest tool waits for acceptance and its open confirmation follows the latest issue", async ({ page, api }) => {
  const id = await handBack(api, "farm-accept");
  await page.goto("/farm/farm-accept");
  const village = page.getByTestId("village");
  await expect(village).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const soil = await bed(page);
  await page.keyboard.press("5");
  await page.mouse.move(soil.x, soil.y);
  await expect(village).toHaveCSS("cursor", /harvest-no/);
  await page.mouse.click(soil.x, soil.y);
  await expect(page.getByRole("dialog", { name: /^收获/ })).toHaveCount(0);
  await page.keyboard.press("1");
  await page.mouse.click(soil.x, soil.y);
  const detail = page.getByRole("dialog", { name: "阿狐的地" });
  await detail.getByRole("button", { name: "验收通过", exact: true }).click();
  await expect(detail.getByRole("button", { name: "收获", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("5");
  await page.mouse.move(soil.x, soil.y);
  await expect(village).toHaveCSS("cursor", /harvest-ok/);
  await page.mouse.click(soil.x, soil.y);
  const review = page.getByRole("dialog", { name: "收获阿狐的地" });
  const take = review.getByRole("button", { name: /确认收获/ });
  await expect(take).toBeVisible();
  await api.issue.act({ id, body: { act: "tell", text: "发呆后检查一下" } });
  await expect.poll(async () => (await api.issue.get({ id })).attention.acts).toContain("accept");
  await expect(take).toHaveCount(0);
  await expect(review).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("farm-awaiting-acceptance.png") });
  await api.issue.act({ id, body: { act: "accept" } });
  await expect(take).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("farm-harvest.png") });
  const harvest = page.waitForRequest((r) => r.url().endsWith(`/issues/${id}/act`) && r.postDataJSON()?.act === "harvest");
  await take.click();
  await harvest;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("done");
});

test("the workbench close dialog only offers the issue's current acts and closes through issue.act", async ({ page, api }) => {
  const id = await handBack(api, "close-accept");
  await page.goto(`/issues/${id}`);
  const detail = page.getByRole("dialog", { name: "工单", exact: true });
  await detail.getByRole("button", { name: "关上", exact: true }).click();
  const closing = page.getByRole("dialog", { name: /^关上「/ });
  await expect(closing).toBeVisible();
  const harvest = closing.getByRole("button", { name: "看收成清单，收获" });
  await expect(harvest).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("close-awaiting-acceptance.png") });
  await api.issue.act({ id, body: { act: "accept" } });
  await expect(harvest).toBeVisible();
  await api.issue.act({ id, body: { act: "tell", text: "发呆后再看看" } });
  await expect(harvest).toHaveCount(0);
  await expect.poll(async () => (await api.issue.get({ id })).attention.acts).toContain("accept");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("close-awaiting-acceptance-narrow.png") });
  const close = page.waitForRequest((r) => r.url().endsWith(`/issues/${id}/act`) && r.postDataJSON()?.act === "close");
  await closing.getByRole("button", { name: "不收，直接收工" }).click();
  await close;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("canceled");
});

test("the workbench harvest confirmation withdraws harvest while a new round requires acceptance", async ({ page, api }) => {
  const id = await handBack(api, "review-accept");
  await api.issue.act({ id, body: { act: "accept" } });
  await page.goto(`/issues/${id}`);
  const detail = page.getByRole("dialog", { name: "工单", exact: true });
  await detail.getByRole("button", { name: "收获", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^关上「/ });
  const take = review.getByRole("button", { name: /确认收获/ });
  await expect(take).toBeVisible();
  await api.issue.act({ id, body: { act: "tell", text: "发呆后再检查" } });
  await expect.poll(async () => (await api.issue.get({ id })).attention.acts).toContain("accept");
  await expect(take).toHaveCount(0);
  await expect(review).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("workbench-awaiting-acceptance.png") });
  await api.issue.act({ id, body: { act: "accept" } });
  await expect(take).toBeVisible();
  const harvest = page.waitForRequest((r) => r.url().endsWith(`/issues/${id}/act`) && r.postDataJSON()?.act === "harvest");
  await take.click();
  await harvest;
  await expect.poll(async () => (await api.issue.get({ id })).status).toBe("done");
});
