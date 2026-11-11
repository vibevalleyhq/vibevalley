import AxeBuilder from "@axe-core/playwright";

import { BizCode } from "@vibevalley/protocol/api";

import { expect, settled, test } from "./fixtures";

test.use({ farm: "owned-primitives", viewport: { width: 390, height: 844 } });
const gate = () => {
  let open: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    wait,
    open: () => {
      if (!open) throw new Error("Gate not initialized");
      open();
    },
  };
};
test.afterEach(async ({ api }) => {
  await api.setting.update({ deepseekApiKey: "" });
});

test("regression: a key receipt and query refresh never erase a newer secret", async ({ page, api }, info) => {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (/\[(STRICT_|REACTIVITY_|NO_OWNER_|REACTIVE_WRITE_)/u.test(message.text())) diagnostics.push(message.text());
  });
  await page.goto("/settings/accounts");
  const input = page.getByTestId("deepseek-key").getByTestId("secret");
  const release = gate();
  const received = gate();
  await page.route("**/api/v1/setting/update", async (route) => {
    const response = await route.fetch();
    received.open();
    await release.wait;
    await route.fulfill({ response });
  });
  await input.fill("test-key-first-1111");
  await page.getByTestId("deepseek-form").getByTestId("save").click();
  await received.wait;
  await input.fill("test-key-newer-2222");
  release.open();
  await expect(page.getByTestId("deepseek-form").getByTestId("save")).toBeEnabled();
  await expect(input).toHaveValue("test-key-newer-2222");
  expect((await api.setting.get()).deepseekApiKey.hint).toMatch(/1111/u);
  await page.unroute("**/api/v1/setting/update");
  await expect(page.locator("#opening")).toHaveCount(0);
  await page.getByTestId("deepseek-form").scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: info.outputPath("secret-form-390.png") });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByTestId("deepseek-form").getByTestId("save").click();
  await expect(input).toHaveValue("");
  expect((await api.setting.get()).deepseekApiKey.hint).toMatch(/2222/u);
  expect(diagnostics).toEqual([]);
});

test("regression: a refused or lost key acknowledgement preserves input without retrying the write", async ({ page, api }) => {
  await page.goto("/settings/accounts");
  const input = page.getByTestId("deepseek-key").getByTestId("secret");
  let calls = 0;
  await page.route("**/api/v1/setting/update", async (route) => {
    calls++;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ bizCode: BizCode.SettingRefused, message: "test refusal" }),
    });
  });
  await input.fill("test-key-refused-3333");
  await page.getByTestId("deepseek-form").getByTestId("save").click();
  await expect(page.getByTestId("deepseek-form").locator("[data-form-summary]")).toBeVisible();
  await expect(input).toHaveValue("test-key-refused-3333");
  expect((await api.setting.get()).deepseekApiKey.source).toBeNull();
  expect(calls).toBe(1);
  await page.unroute("**/api/v1/setting/update");
  await page.route("**/api/v1/setting/update", async (route) => {
    calls++;
    await route.fetch();
    await route.abort("failed");
  });
  await input.fill("test-key-unknown-4444");
  await page.getByTestId("deepseek-form").getByTestId("save").click();
  await expect(page.getByTestId("deepseek-form").getByTestId("save")).toBeEnabled();
  await expect(input).toHaveValue("test-key-unknown-4444");
  expect((await api.setting.get()).deepseekApiKey.hint).toMatch(/4444/u);
  expect(calls).toBe(2);
});

test("regression: editing during skill-list refresh keeps the editor and the created identity", async ({ page, api }, info) => {
  await page.goto("/settings/skills/new");
  const name = page.getByTestId("skill-name");
  await name.fill("Before refresh");
  await page.getByTestId("skill-body").fill("Preserve the newer input while refreshing the saved list.");
  const received = gate();
  const release = gate();
  await page.route("**/api/v1/skill/list", async (route) => {
    const response = await route.fetch();
    received.open();
    await release.wait;
    await route.fulfill({ response });
  });
  await page.getByTestId("save").click();
  await received.wait;
  await name.fill("After refresh started");
  release.open();
  await expect(page.getByTestId("save")).toBeEnabled();
  await expect(page).toHaveURL(/\/settings\/skills\/new$/u);
  await expect(name).toHaveValue("After refresh started");
  await expect(page.locator("#opening")).toHaveCount(0);
  await page.getByTestId("skill-form").scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: info.outputPath("skill-form-390.png") });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.unroute("**/api/v1/skill/list");
  const before = await api.skill.list();
  await page.getByTestId("save").click();
  await expect(page).not.toHaveURL(/\/new$/u);
  const after = await api.skill.list();
  expect(after).toHaveLength(before.length);
  const saved = after.find((skill) => skill.name === "After refresh started");
  expect(saved).toBeDefined();
  if (saved) await api.skill.delete({ id: saved.id });
});
