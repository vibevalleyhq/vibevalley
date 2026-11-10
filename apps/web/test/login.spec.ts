import { expect, test } from "./fixtures";

// Its own server: the password it sets would send every other file's devices to sign in rather than pair.
test.use({ farm: "login" });

test("this computer sets the password; a device signs in with it through the gate, is the user, and signs out", async ({ browser, page: here, api }) => {
  await api.lan.update({ open: true });
  try {
    const { url } = await api.lan.get();
    const laptop = await browser.newContext();
    const page = await laptop.newPage();
    // No password yet: there is nothing to sign in with, so it pairs.
    await page.goto(url + "/issues");
    await expect(page).toHaveURL(/\/pair$/u);
    await here.goto("/settings/devices");
    await here.getByTestId("account-name").fill("小明");
    await here.getByTestId("account-name-save").click();
    await expect.poll(() => api.user.get().then((s) => s.name)).toBe("小明");
    await here.getByTestId("account-password").fill("correct horse");
    await here.getByTestId("account-password-save").click();
    await expect.poll(() => api.user.get().then((s) => s.password)).toBe(true);
    await page.goto(url + "/issues");
    await expect(page).toHaveURL(/\/login$/u);
    await page.getByTestId("login-password").fill("wrong horse");
    await page.getByTestId("login-submit").click();
    await expect(page.getByRole("alert")).not.toBeEmpty();
    await page.getByTestId("login-password").fill("correct horse");
    await page.getByTestId("login-device").fill("laptop");
    await page.getByTestId("login-submit").click();
    await expect(page).not.toHaveURL(/\/login$/u);
    // Signed in, it is the user: the devices page, which a paired device could not open, lists it as signed in.
    await page.goto(url + "/settings/devices");
    await expect(page.locator('[data-testid="devices"] [data-came="login"]')).toHaveCount(1);
    await expect(page.getByTestId("account-password")).toHaveCount(0);
    await page.getByTestId("account-sign-out").click();
    await expect(page).toHaveURL(/\/login$/u);
    expect(await api.user.device.list()).toEqual([]);
    await laptop.close();
  } finally {
    await api.lan.update({ open: false });
  }
});
