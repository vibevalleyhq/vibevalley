import { expect, test } from "./fixtures";

// A server of its own: a second orchestrator is the whole farm's, and the other files count one.
test.use({ farm: "orchestrators" });

test("a second orchestrator: made on the profiles page, answers in its own direct channel, and looks after a channel", async ({ page, api }) => {
  await page.goto("/agents");
  await page.getByRole("link", { name: "添一个管家" }).click();
  await expect(page).toHaveURL(/\/agents\/new\?role=orchestrator$/);
  await page.getByLabel("名字", { exact: true }).fill("阿青");
  await page.getByLabel("职责").fill("专管 notes");
  await page.getByRole("radio", { name: "园艺师" }).click();
  await page.getByRole("button", { name: "捏好了，保存" }).click();
  await expect(page).toHaveURL(/\/agents\/(?!new).+/);
  await expect(page.getByText("已保存")).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  const made = (await api.agent.list()).find((a) => a.id === id)!;
  expect([made.role, made.runtime, made.look.orchestrator]).toEqual(["orchestrator", "vibevalley", "gardener"]);

  // Without a model key it says it cannot start, as itself, in its own direct channel.
  await page.getByRole("button", { name: "私聊" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  const box = page.getByRole("textbox", { name: "发送消息至 阿青" });
  await box.fill("在吗");
  await box.press("Enter");
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("阿青", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(log.getByText(/DeepSeek 的钥匙/)).toBeVisible();

  const general = (await api.channel.list()).find((c) => c.default)!;
  await page.goto(`/chat/${general.id}`);
  await page.getByRole("button", { name: "频道设置" }).click();
  const dialog = page.getByRole("dialog", { name: /的设置$/ });
  await dialog.getByRole("combobox", { name: "照看的管家" }).selectOption({ label: "阿青" });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("complementary", { name: "频道和帮工" }).getByLabel("管家")).toContainText("阿青");
  expect((await api.channel.list()).find((c) => c.id === general.id)!.orchestrator).toBe(id);

  await page.goto("/agents");
  await page.getByRole("link", { name: "阿青" }).click();
  await expect(page).toHaveURL(new RegExp(`/orchestrator/${id}/memory$`));
  await expect(page.getByRole("heading", { name: "阿青" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "轨迹" })).toBeVisible();
  // The phone is the default orchestrator's: another has no voice.
  await expect(page.getByRole("tab", { name: "声音" })).toHaveCount(0);
  // Its memory is its own MEMORY.md: a note for it is not the default one's.
  await page.getByLabel("替它记一条").fill("notes 先跑测试");
  await page.getByRole("button", { name: "记下" }).click();
  await expect(page.getByRole("region", { name: "记下的" }).getByText("notes 先跑测试")).toBeVisible();
  expect((await api.memory.list({ agent: "orchestrator" })).memories.map((m) => m.text)).not.toContain("notes 先跑测试");
  await page.screenshot({ path: test.info().outputPath("second-orchestrator.png") });
  await page.goto("/agents");
  await page.screenshot({ path: test.info().outputPath("profiles.png") });
});
