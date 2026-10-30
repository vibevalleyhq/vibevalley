// /pair, where another device joins the farm (连接到本机): the owner's link opens it through the lan listener, the
// device asks, the owner nods, and from then on the device's browser is let in by the cookie it keeps.
import { expect, test } from "./fixtures";

test("a device names itself, asks, and is told why not", async ({ page }) => {
  await page.goto("/pair?c=ABCDE12345");
  await expect(page.getByTestId("pair-code")).toHaveCount(0);
  await page.getByTestId("pair-name").fill("test phone");
  await page.getByTestId("pair-ask").click();
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await expect(page).toHaveURL(/\/pair/u);
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
    await expect(page).toHaveURL(/\/pair$/u);
    // Without a code there is nothing to ask with.
    await expect(page.getByTestId("pair-ask")).toBeDisabled();
    await page.goto(pairing!.link);
    await expect(page.getByTestId("pair-name")).toHaveValue("iPhone");
    await page.getByTestId("pair-ask").click();
    await expect(page.getByRole("status")).toBeVisible();
    await expect.poll(async () => (await api.lan.get()).pairing?.asking).toBe("iPhone");
    await api.lan.pairing.answer({ allow: true });
    await expect(page).toHaveURL(url + "/chat");
    await page.goto(url + "/issues");
    await expect(page.locator('[data-testid="lane"][data-key="todo"]')).toBeVisible();
    await phone.close();
    const { devices } = await api.lan.get();
    for (const d of devices) await api.lan.device.delete({ id: d.id });
  } finally {
    await api.lan.update({ open: false });
  }
});
