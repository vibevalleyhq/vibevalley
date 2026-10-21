import { expect, test } from "./fixtures";

// The worker's server is shared by its tests: each puts back what it changed.

test("设置 lists its parts, and /settings opens the first", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/deepseek$/);
  const menu = page.getByRole("region", { name: "设置的分区" });
  for (const label of ["DeepSeek", "Agora 语音", "记性", "GitHub", "连接器", "技能", "声音", "连接到本机"])
    await expect(menu.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
  await expect(menu.getByRole("link", { name: /^DeepSeek/ })).toHaveAttribute("aria-current", "page");
  await menu.getByRole("link", { name: /^GitHub/ }).click();
  await expect(page).toHaveURL(/\/settings\/github$/);
  await expect(page.getByRole("button", { name: "重新检测" })).toBeVisible();
});

test("a DeepSeek key is saved, shown by its end and cleared", async ({ page }) => {
  await page.goto("/settings/deepseek");
  await expect(page.getByText("还没有")).toBeVisible();
  const key = page.getByLabel("DeepSeek API Key", { exact: true });
  await key.fill("sk-test-0123456789abcdef");
  await expect(key).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "看一眼" }).click();
  await expect(key).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("存好了，马上就用上。")).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(page.getByText(/^在用 .*cdef.*（存在设置里）$/)).toBeVisible();
  await page.getByRole("button", { name: "清掉" }).click();
  await expect(page.getByText("存的时候清掉")).toBeVisible();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("还没有")).toBeVisible();
});

test("a memory source is opened, connected and let go", async ({ page }) => {
  await page.goto("/settings/memory");
  await expect(page.getByText("记性的来源：EverOS（没接）")).toBeVisible();
  await page.getByRole("button", { name: "改 EverOS" }).click();
  await page.getByLabel("EverOS 的地址").fill("http://127.0.0.1:18791");
  await page.getByRole("switch", { name: "接上" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("记性的来源：EverOS（接上了）")).toBeVisible();
  await page.getByRole("button", { name: "改 EverOS" }).click();
  await page.getByLabel("EverOS 的地址").fill("");
  await page.getByRole("switch", { name: "接上" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("记性的来源：EverOS（没接）")).toBeVisible();
});

test("a skill of VibeValley's own is written, listed and deleted", async ({ page }) => {
  await page.goto("/settings/skills/new");
  await expect(page.getByRole("heading", { name: "新技能" })).toBeVisible();
  const save = page.getByRole("button", { name: "保存" });
  await expect(save).toBeDisabled();
  await page.getByLabel("技能名字").fill("先写测试");
  await page.getByLabel("技能说明").fill("改行为之前，先补一个会失败的测试。");
  await page.getByLabel("正文").fill("改任何行为之前，先写一个能复现问题的测试。");
  await save.click();
  await expect(page).toHaveURL(/\/settings\/skills\/(?!new).+/);
  const book = page.getByRole("navigation", { name: "技能书" });
  await expect(book.getByRole("link", { name: /先写测试/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("还没有 agent 带这个技能。")).toBeVisible();
  await page.getByLabel("搜索技能").fill("没有这种");
  await expect(book.getByRole("link", { name: /先写测试/ })).toBeHidden();
  await page.getByLabel("搜索技能").fill("");
  await page.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("删掉？")).toBeVisible();
  await page.getByRole("button", { name: "删除" }).click();
  await expect(page).toHaveURL(/\/settings\/skills$/);
  await expect(book.getByRole("link", { name: /先写测试/ })).toBeHidden();
});

test("the connectors show how each one connects", async ({ page }) => {
  await page.goto("/settings/connectors");
  const list = page.getByRole("region", { name: "连接器列表" });
  await expect(list.getByRole("link", { name: /微信/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "微信扫码登录" })).toBeVisible();
  await list.getByRole("link", { name: /QQ/ }).click();
  await expect(page).toHaveURL(/\/settings\/connectors\/qq$/);
  const connect = page.getByRole("button", { name: "连接 QQ 机器人" });
  await expect(connect).toBeDisabled();
  await page.getByLabel("AppID").fill("102000000");
  await page.getByLabel("AppSecret").fill("secret");
  await expect(connect).toBeEnabled();
  await expect(page.getByText("QQ 只让机器人在你说话后的一小段时间里回复。", { exact: false })).toBeVisible();
});

test("连接到本机 opens, shows a pairing code and closes", async ({ page }) => {
  await page.goto("/settings/lan");
  await page.getByRole("button", { name: "允许连接" }).click();
  await expect(page.getByText("开着")).toBeVisible();
  await expect(page.getByText(/^http:\/\/[\d.]+:\d+$/)).toBeVisible();
  await page.getByRole("button", { name: "添加设备" }).click();
  await expect(page.getByRole("img", { name: "配对二维码" })).toBeVisible();
  await expect(page.getByText(/^http:\/\/[\d.]+:\d+\/pair\?c=/)).toBeVisible();
  await expect(page.getByText(/还有 \d+ 秒有效/)).toBeVisible();
  await page.getByRole("button", { name: "不加了" }).click();
  await page.getByRole("button", { name: "关掉连接" }).click();
  await expect(page.getByRole("button", { name: "允许连接" })).toBeVisible();
});

test("the voice line saves its own part and goes back to the defaults", async ({ page }) => {
  await page.goto("/settings/voice");
  await expect(page.getByText("都存着。")).toBeVisible();
  const area = page.getByRole("group", { name: "区域" });
  await area.getByRole("button", { name: "欧洲" }).click();
  await expect(page.getByText("有没存的改动。")).toBeVisible();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("存好了，下一通电话就用上。")).toBeVisible();
  await page.reload();
  await expect(area.getByRole("button", { name: "欧洲" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "恢复默认" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("存好了，下一通电话就用上。")).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复默认" })).toBeDisabled();
});

test("设置 as it looks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const part of ["deepseek", "memory", "connectors", "skills", "voice", "lan"]) {
    await page.goto(`/settings/${part}`);
    await expect(page.getByRole("region", { name: "设置的分区" })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath(`settings-${part}.png`) });
  }
});
