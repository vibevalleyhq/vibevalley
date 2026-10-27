// /pair, where another device joins the farm (连接到本机): the owner's link opens it through the lan listener, the
// device asks, the owner nods, and from then on the device's browser is let in by the cookie it keeps.
import { expect, test } from "./fixtures";

test("a device names itself, questions, and is told why not", async ({ page }) => {
  await page.goto("/pair?c=ABCDE12345");
  await expect(page.getByRole("heading", { name: "连进那台电脑" })).toBeVisible();
  await expect(page.getByLabel("配对码")).toHaveCount(0);
  await page.getByLabel("这台设备叫").fill("测试的手机");
  await page.getByRole("button", { name: "请主人放行" }).click();
  await expect(page.getByRole("alert")).toContainText("没允许连接");
  await expect(page).toHaveURL(/\/pair/);
});

test("without a code it asks for one", async ({ page }) => {
  await page.goto("/pair");
  await expect(page.getByRole("button", { name: "请主人放行" })).toBeDisabled();
  await page.getByLabel("配对码").fill("abcde12345");
  await expect(page.getByRole("button", { name: "请主人放行" })).toBeEnabled();
});

test("a device the owner lets in opens the farm through the lan listener", async ({ browser, api }) => {
  await api.lan.update({ open: true });
  try {
    const { pairing, url } = await api.lan.pairing.start();
    expect(pairing?.link.startsWith(url + "/pair?c=")).toBe(true);
    const phone = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)" });
    const page = await phone.newPage();
    // Not paired yet: wherever it opens, it is sent to pair first.
    await page.goto(url + "/issues");
    await expect(page).toHaveURL(/\/pair$/);
    await page.goto(pairing!.link);
    await expect(page.getByLabel("这台设备叫")).toHaveValue("iPhone");
    await page.getByRole("button", { name: "请主人放行" }).click();
    await expect(page.getByRole("status")).toContainText("等那台电脑上的主人点头");
    await expect.poll(async () => (await api.lan.get()).pairing?.asking).toBe("iPhone");
    await api.lan.pairing.answer({ allow: true });
    await expect(page).toHaveURL(url + "/");
    await page.goto(url + "/issues");
    await expect(page.getByRole("region", { name: "待办", exact: true })).toBeVisible();
    await phone.close();
    const { devices } = await api.lan.get();
    for (const d of devices) await api.lan.device.delete({ id: d.id });
  } finally {
    await api.lan.update({ open: false });
  }
});
