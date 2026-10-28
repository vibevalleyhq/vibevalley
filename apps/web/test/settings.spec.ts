import { expect, settled, test } from "./fixtures";

// The worker's server is shared by its tests: each puts back what it changed.

test("设置 lists its sections in groups, opens on 通用, and the search narrows them", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  const menu = page.getByRole("navigation", { name: "设置的分区" });
  for (const group of ["选项", "帮工", "语音", "连接"]) await expect(menu.getByText(group, { exact: true })).toBeVisible();
  for (const label of ["通用", "外观", "模型", "关于", "记性", "技能", "通话线路", "MOSS Live", "听写", "GitHub", "聊天软件", "设备"])
    await expect(menu.getByRole("link", { name: label, exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "通用", exact: true })).toHaveAttribute("aria-current", "page");
  await menu.getByRole("link", { name: "GitHub", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/github$/);
  await expect(page.getByRole("button", { name: "重新检测" })).toBeVisible();
  // A section is found by the names of its settings, not only its own.
  await page.getByLabel("搜索设置…").fill("深色");
  await expect(menu.getByRole("link")).toHaveCount(1);
  await expect(menu.getByRole("link", { name: "外观", exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "外观", exact: true }).click();
  await expect(page.locator("[data-found]")).toHaveCount(1);
  await page.getByLabel("搜索设置…").fill("");
  await expect(menu.getByRole("link")).toHaveCount(12);
});

test("外观 and 通用 keep this device's choices", async ({ page }) => {
  await page.goto("/settings/appearance");
  const theme = page.getByRole("group", { name: "主题" });
  await theme.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: test.info().outputPath("settings-dark.png") });
  await page.reload();
  await expect(theme.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");
  await theme.getByRole("button", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("group", { name: "界面大小" }).getByRole("button", { name: "125%" }).click();
  await expect(page.getByRole("group", { name: "界面大小" }).getByRole("button", { name: "125%" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "界面大小" }).getByRole("button", { name: "100%" }).click();
  await theme.getByRole("button", { name: "跟随系统" }).click();
  await page.goto("/settings/general");
  await page.getByRole("group", { name: "启动时打开" }).getByRole("button", { name: "农场" }).click();
  await page.goto("/");
  await expect(page).toHaveURL(/\/farm/);
  await page.goto("/settings/general");
  await page.getByRole("group", { name: "启动时打开" }).getByRole("button", { name: "工作台" }).click();
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat$/);
});

test("a DeepSeek key is saved, shown by its end and removed", async ({ page }) => {
  await page.goto("/settings/models");
  await expect(page.getByRole("img", { name: "还没设" })).toBeVisible();
  const key = page.getByLabel("API Key", { exact: true });
  await key.fill("sk-test-0123456789abcdef");
  await expect(key).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "看一眼" }).click();
  await expect(key).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("存好了，马上就用上。")).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(page.getByRole("img", { name: /^在用 .*cdef.*（存在设置里）$/ })).toBeVisible();
  await page.getByRole("button", { name: "移除 API Key" }).click();
  await expect(page.getByRole("img", { name: "保存后移除" })).toBeVisible();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("img", { name: "还没设" })).toBeVisible();
});

test("a memory source is set up, turned on and let go", async ({ page }) => {
  await page.goto("/settings/memory");
  await expect(page.getByRole("img", { name: "没接" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "保存" })).toHaveCount(0);
  await page.getByRole("button", { name: "配置 EverOS" }).click();
  await page.getByLabel("EverOS 的地址").fill("http://127.0.0.1:18791");
  await page.getByRole("switch", { name: "启用 EverOS" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("img", { name: "接上了 · http://127.0.0.1:18791" })).toBeVisible();
  await page.getByRole("button", { name: "配置 EverOS" }).click();
  await page.getByLabel("EverOS 的地址").fill("");
  await page.getByRole("switch", { name: "启用 EverOS" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("img", { name: "没接" })).toHaveCount(2);
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
  await page.goto("/settings/chat");
  const list = page.getByRole("region", { name: "连接器列表" });
  await expect(list.getByRole("link", { name: /微信/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "微信扫码登录" })).toBeVisible();
  await list.getByRole("link", { name: /QQ/ }).click();
  await expect(page).toHaveURL(/\/settings\/chat\/qq$/);
  const connect = page.getByRole("button", { name: "连接 QQ 机器人" });
  await expect(connect).toBeDisabled();
  await page.getByLabel("AppID").fill("102000000");
  await page.getByLabel("AppSecret").fill("secret");
  await expect(connect).toBeEnabled();
  await expect(page.getByText("QQ 只让机器人在你说话后的一小段时间里回复。", { exact: false })).toBeVisible();
});

test("连接到本机 opens, shows a pairing code and closes", async ({ page }) => {
  await page.goto("/settings/devices");
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
  await page.goto("/settings/call");
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  const area = page.getByRole("group", { name: "区域" });
  await area.getByRole("button", { name: "欧洲" }).click();
  await expect(page.getByRole("button", { name: "撤销" })).toBeVisible();
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
  for (const part of ["general", "appearance", "models", "about", "memory", "skills", "call", "moss", "dictation", "github", "chat", "devices"]) {
    await page.goto(`/settings/${part}`);
    await expect(page.getByRole("navigation", { name: "设置的分区" })).toBeVisible();
    await settled(page);
    await page.screenshot({ path: test.info().outputPath(`settings-${part}.png`) });
  }
});
