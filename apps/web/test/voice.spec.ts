// The call and dictation as far as a test server goes: it has no Agora keys and no transcriber, so a call is refused by
// the server before any SDK is loaded, and dictation waits to be set up.

import { pathOf } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("a call without Agora's keys says why, offers 设置, and the line tries again", async ({ page }) => {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  // Calling is the phone's: tapping 管家 dials it, and its line's key tries again.
  await page.getByRole("button", { name: "手机" }).click();
  const phone = page.getByRole("region", { name: "农场手机" });
  await phone.getByRole("button", { name: "管家" }).click();
  await expect(phone.getByText(/^没接通：/)).toBeVisible({ timeout: 10_000 });
  const again = page.waitForRequest((r) => r.url().endsWith(pathOf("voice.session.create")) && r.method() === "POST");
  await phone.getByRole("button", { name: "打给管家" }).click();
  await again;
  // The reason under the chat's head, with the way to the setting that fixes it.
  const problem = page.getByRole("alert").filter({ hasText: "语音没接通" });
  await expect(problem).toContainText("Agora");
  await problem.getByRole("button", { name: "去设置" }).click();
  await expect(page).toHaveURL(/\/settings\/agora$/);
  await expect(page.getByLabel("Agora App ID")).toBeVisible();
});

test("dictation waits for a transcriber to be set in 声音", async ({ page }) => {
  await page.goto("/chat");
  const dictate = page.getByRole("button", { name: "听写" });
  await expect(dictate).toBeDisabled();
  await expect(dictate).toHaveAttribute("title", /听写还没配/);
});

test("` opens the debug console over the farm, and its level-up shows the banner", async ({ page }) => {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.keyboard.press("`");
  const debug = page.getByRole("complementary", { name: "调试台" });
  await expect(debug).toBeVisible();
  await debug.getByRole("button", { name: "升一级（带横幅）" }).click();
  await expect(page.getByRole("status", { name: /农场升到 Lv\.\d+/ })).toBeVisible();
  await debug.getByRole("button", { name: "停", exact: true }).click();
  await expect(debug.getByRole("button", { name: "停", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(debug.getByText(/^call=/).first()).toBeVisible();
  await debug.getByRole("button", { name: "关闭 `" }).click();
  await expect(debug).toBeHidden();
});
