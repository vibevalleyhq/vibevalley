import { expect, test } from "./fixtures";

// The worker's server is shared by its tests: each puts back what it changed.

const sections = ["general", "appearance", "models", "about", "memory", "skills", "call", "moss", "dictation", "github", "chat", "devices"];

test("settings lists its sections, opens on general, and the search narrows them", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  const nav = page.getByTestId("settings-nav");
  const links = nav.locator("a[data-key]");
  await expect(links).toHaveCount(sections.length);
  for (const id of sections) await expect(nav.locator(`[data-key="${id}"]`)).toBeVisible();
  await expect(nav.locator('[data-key="general"]')).toHaveAttribute("aria-current", "page");
  await nav.locator('[data-key="github"]').click();
  await expect(page).toHaveURL(/\/settings\/github$/);
  await expect(page.getByTestId("github-recheck")).toBeVisible();
  // What a search matches is base/search.test.ts's; here it narrows the sections and lights the rows.
  await page.getByTestId("settings-search").fill("MOSS");
  await expect(links).toHaveCount(1);
  await nav.locator('[data-key="moss"]').click();
  await expect(page.locator("[data-found]").first()).toBeVisible();
  await page.getByTestId("settings-search").fill("");
  await expect(links).toHaveCount(sections.length);
});

test("appearance and general keep this device's choices", async ({ page }) => {
  await page.goto("/settings/appearance");
  const theme = page.getByTestId("theme");
  await theme.locator('[data-key="dark"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(theme.locator('[data-key="dark"]')).toHaveAttribute("aria-pressed", "true");
  await theme.locator('[data-key="light"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const scale = page.getByTestId("scale");
  await scale.locator('[data-key="125"]').click();
  await expect(scale.locator('[data-key="125"]')).toHaveAttribute("aria-pressed", "true");
  await scale.locator('[data-key="100"]').click();
  await theme.locator('[data-key="system"]').click();
  await page.goto("/settings/general");
  await page.getByTestId("start").locator('[data-key="farm"]').click();
  await page.goto("/");
  await expect(page).toHaveURL(/\/farm/);
  await page.goto("/settings/general");
  await page.getByTestId("start").locator('[data-key="workbench"]').click();
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat$/);
});

test("a DeepSeek key is saved, shown by its end and removed", async ({ page }) => {
  await page.goto("/settings/models");
  const row = page.getByTestId("deepseek-key");
  const mark = row.getByTestId("key-mark");
  await expect(mark).toHaveAttribute("data-state", "unset");
  const key = row.getByTestId("secret");
  await key.fill("sk-test-0123456789abcdef");
  await expect(key).toHaveAttribute("type", "password");
  await row.getByTestId("reveal").click();
  await expect(key).toHaveAttribute("type", "text");
  await page.getByTestId("save").click();
  await expect(key).toHaveValue("");
  await expect(mark).toHaveAttribute("data-state", "settings");
  await expect(mark).toHaveAttribute("data-hint", /cdef/);
  await row.getByTestId("remove-key").click();
  await expect(mark).toHaveAttribute("data-state", "removing");
  await page.getByTestId("save").click();
  await expect(mark).toHaveAttribute("data-state", "unset");
});

test("a memory source is set up, turned on and let go", async ({ page }) => {
  await page.goto("/settings/memory");
  await expect(page.locator('[data-testid="source-mark"][data-state="unset"]')).toHaveCount(2);
  await expect(page.getByTestId("save")).toHaveCount(0);
  const everos = page.locator('[data-testid="source"][data-key="everos"]');
  await everos.getByTestId("source-configure").click();
  await everos.getByTestId("source-address").fill("http://127.0.0.1:18791");
  await everos.getByTestId("source-enable").click();
  await page.getByTestId("save").click();
  await expect(everos.getByTestId("source-mark")).toHaveAttribute("data-state", "on");
  await everos.getByTestId("source-configure").click();
  await everos.getByTestId("source-address").fill("");
  await everos.getByTestId("source-enable").click();
  await page.getByTestId("save").click();
  await expect(page.locator('[data-testid="source-mark"][data-state="unset"]')).toHaveCount(2);
});

test("a skill of VibeValley's own is written, listed and deleted", async ({ page }) => {
  await page.goto("/settings/skills/new");
  const save = page.getByTestId("save");
  await expect(save).toBeDisabled();
  await page.getByTestId("skill-name").fill("test first");
  await page.getByTestId("skill-description").fill("Before changing behaviour, add a failing test.");
  await page.getByTestId("skill-body").fill("Write a test that reproduces the problem before changing anything.");
  await save.click();
  await expect(page).toHaveURL(/\/settings\/skills\/(?!new).+/);
  const path = new URL(page.url()).pathname;
  const entry = page.getByTestId("skills-book").locator(`[data-testid="skill-entry"][href="${path}"]`);
  await expect(entry).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("skill-users")).toHaveAttribute("data-count", "0");
  await page.getByTestId("skills-search").fill("nothing like this");
  await expect(entry).toBeHidden();
  await page.getByTestId("skills-search").fill("");
  await page.getByTestId("delete").click();
  await page.getByTestId("delete-sure").click();
  await expect(page).toHaveURL(/\/settings\/skills$/);
  await expect(entry).toBeHidden();
});

test("the connectors show how each one connects", async ({ page }) => {
  await page.goto("/settings/chat");
  const list = page.getByTestId("connectors");
  await expect(list.locator('[data-key="weixin"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("connector-login")).toBeEnabled();
  await list.locator('[data-key="qq"]').click();
  await expect(page).toHaveURL(/\/settings\/chat\/qq$/);
  const connect = page.getByTestId("connector-login");
  await expect(connect).toBeDisabled();
  await page.getByTestId("qq-app-id").fill("102000000");
  await page.getByTestId("qq-secret").fill("secret");
  await expect(connect).toBeEnabled();
});

test("connecting to this machine opens, shows a pairing code and closes", async ({ page }) => {
  await page.goto("/settings/devices");
  await page.getByTestId("lan-allow").click();
  await expect(page.getByTestId("lan-url")).toHaveText(/^http:\/\/[\d.]+:\d+$/);
  await page.getByTestId("lan-add").click();
  const pairing = page.getByTestId("pairing");
  await expect(pairing.getByTestId("pairing-qr")).toBeVisible();
  await expect(pairing.getByTestId("pairing-link")).toHaveText(/^http:\/\/[\d.]+:\d+\/pair\?c=/);
  await expect(pairing).toHaveAttribute("data-left", /^[1-9]\d*$/);
  await pairing.getByTestId("pairing-stop").click();
  await page.getByTestId("lan-close").click();
  await expect(page.getByTestId("lan-allow")).toBeVisible();
});

test("the voice line saves its own part and goes back to the defaults", async ({ page }) => {
  await page.goto("/settings/call");
  const save = page.getByTestId("save");
  await expect(save).toBeDisabled();
  const area = page.getByTestId("voice-area");
  await area.locator('[data-key="EU"]').click();
  await expect(page.getByTestId("undo")).toBeVisible();
  await save.click();
  await expect(page.getByTestId("save-bar")).not.toHaveAttribute("data-dirty");
  await page.reload();
  await expect(area.locator('[data-key="EU"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("reset").click();
  await save.click();
  await expect(page.getByTestId("save-bar")).not.toHaveAttribute("data-dirty");
  await expect(page.getByTestId("reset")).toBeDisabled();
});

test("dictation goes to MOSS unless the owner picks an own address, which then saves its address and model", async ({ page, api }) => {
  await page.goto("/settings/dictation");
  const via = page.getByTestId("dictation-via");
  await expect(via.locator('[data-key="moss"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("dictation-moss-key").locator("input")).toBeVisible();
  await expect(page.getByTestId("dictation-url")).toHaveCount(0);
  await via.locator('[data-key="own"]').click();
  await expect(page.getByTestId("dictation-moss-key")).toHaveCount(0);
  await page.getByTestId("dictation-url").fill("http://127.0.0.1:8080/v1");
  await page.getByTestId("dictation-model").fill("qwen3");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-bar")).not.toHaveAttribute("data-dirty");
  expect((await api.setting.get()).dictation).toEqual({ via: "own", url: "http://127.0.0.1:8080/v1", model: "qwen3" });
  await via.locator('[data-key="moss"]').click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-bar")).not.toHaveAttribute("data-dirty");
  expect((await api.setting.get()).dictation.via).toBe("moss");
});

test("the settings navigation is as wide as it was dragged, on this machine, until a double click puts it back", async ({ page }) => {
  await page.goto("/settings/general");
  const edge = page.locator('[data-testid="splitter"][data-key="settingsNav"]');
  await expect(edge).toHaveAttribute("aria-valuenow", "224");
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(edge).toHaveAttribute("aria-valuenow", "256");
  const nav = page.getByTestId("settings-nav");
  expect(Math.round((await nav.boundingBox())!.width)).toBe(256);
  await page.reload();
  await expect(edge).toHaveAttribute("aria-valuenow", "256");
  await edge.dblclick();
  await expect(edge).toHaveAttribute("aria-valuenow", "224");
});
