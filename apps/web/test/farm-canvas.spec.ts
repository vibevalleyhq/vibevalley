import { expect, test } from "./fixtures";

test.use({ farm: "farm-canvas" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("the village draws at integer scale and runs without rendering errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  // The page's clock is moved through, frame by frame: a second of the village (sixty frames) without waiting it out.
  await page.clock.install();
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const canvas = page.getByTestId("farm").locator("canvas");
  await expect(canvas).toBeVisible();
  // 384 art pixels fit three times in the space beside the rail at 1280px.
  await expect(canvas).toHaveCSS("width", "1152px");
  await page.clock.runFor(1000);
  expect(errors).toEqual([]);
});

test("the cursor is the tool's, and says whether it can be used where it points", async ({ page }) => {
  await page.goto("/farm/");
  const village = page.getByTestId("village");
  await expect(village).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(village).toHaveCSS("cursor", /hand\.png/u);
  // An empty plot (the top left bed) can be sowed with the hand.
  const box = (await village.locator("canvas").boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.move(box.x + 128 * scale, box.y + 117 * scale);
  await expect(village).toHaveCSS("cursor", /hand-point/u);
  // The watering can on an empty plot: nothing to water.
  await page.keyboard.press("2");
  await expect(village).toHaveCSS("cursor", /water-no/u);
});
