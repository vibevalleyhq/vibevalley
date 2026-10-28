import type { Page } from "@playwright/test";
import type { Agent, VibeValleyApi } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

// A profile no runtime answers to: nothing in these tests may send a real coding agent out.
const helper = (name: string, species: "fox" | "rabbit"): Agent => ({
  id: "",
  name,
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "nobody",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: { species, outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
});

const issue = (
  api: VibeValleyApi,
  title: string,
  more: { description?: string; priority?: "urgent" | "high" | "medium" | "low"; project?: string; assignee?: string } = {},
) => api.issue.create({ title, ...more });

const lane = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("a quick add shows the new issue in 待办 without a reload", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.getByRole("status")).toHaveText("已连上");
  await page.getByRole("textbox", { name: "写一张待办" }).fill("给看板加一个快捷键");
  await page.keyboard.press("Enter");
  await expect(lane(page, "待办").getByRole("button", { name: "给看板加一个快捷键" })).toBeVisible();
  // With no helper and no project the server refuses the draft, after asking the runtimes (a few seconds); the issue opens.
  await expect(page.getByRole("log", { name: "提示" })).toContainText("先没起草", { timeout: 20_000 });
  await expect(page).toHaveURL(/\/issues\/.+/);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/issues$/);
  await expect(lane(page, "待办").getByRole("button", { name: "给看板加一个快捷键" })).toBeVisible();
});

test("the list view and its grouping are kept across a reload", async ({ page, api }) => {
  await issue(api, "列表里的一张");
  await page.goto("/issues");
  await page.getByRole("group", { name: "看法" }).getByRole("button", { name: "列表" }).click();
  await page.getByRole("button", { name: "显示" }).click();
  await page.getByRole("dialog", { name: "显示" }).getByRole("group", { name: "分组" }).getByRole("button", { name: "项目" }).click();
  await expect(page.getByRole("region", { name: "没有项目" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("group", { name: "看法" }).getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "没有项目" }).getByRole("button", { name: "列表里的一张" })).toBeVisible();
  await page.getByRole("button", { name: "显示" }).click();
  await page.getByRole("button", { name: "恢复默认" }).click();
  await page.getByRole("group", { name: "看法" }).getByRole("button", { name: "看板" }).click();
  await expect(lane(page, "待办")).toBeVisible();
});

test("an issue opens at its own address and its edits are saved", async ({ page, api }) => {
  const made = await issue(api, "改标题之前");
  await page.goto("/issues");
  await lane(page, "待办").getByRole("button", { name: "改标题之前" }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`));
  const detail = page.getByRole("dialog", { name: "工单" });
  await expect(detail.getByRole("textbox", { name: "标题" })).toHaveValue("改标题之前");
  await detail.getByRole("textbox", { name: "标题" }).fill("改标题之后");
  await detail.getByRole("textbox", { name: "说明" }).fill("登录页要记住上次的用户名。");
  await detail.getByRole("combobox", { name: "优先级" }).selectOption("high");
  await detail.getByRole("button", { name: "存下改动" }).click();
  await expect(detail.getByRole("button", { name: "存下改动" })).toBeDisabled();
  await expect.poll(async () => (await api.issue.get({ id: made.id })).title).toBe("改标题之后");
  const saved = await api.issue.get({ id: made.id });
  expect(saved.description).toBe("登录页要记住上次的用户名。");
  expect(saved.priority).toBe("high");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "工单" }).getByRole("textbox", { name: "标题" })).toHaveValue("改标题之后");
});

test("starting an issue with no helper asks for one", async ({ page, api }) => {
  const made = await issue(api, "还没有帮工的活");
  await page.goto("/issues");
  await lane(page, "待办").getByRole("button", { name: "还没有帮工的活" }).dragTo(lane(page, "处理中"));
  await expect(page.getByRole("log", { name: "提示" })).toContainText("还差一点");
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`));
  await expect(page.getByRole("dialog", { name: "工单" }).getByRole("button", { name: "开工" })).toBeDisabled();
  expect((await api.issue.get({ id: made.id })).status).toBe("backlog");
});

test("an act carries the fields not saved yet, saved before it is tried", async ({ api }) => {
  const made = await issue(api, "带着改动开工之前");
  await expect(api.issue.status.update({ id: made.id, status: "todo", edit: { title: "带着改动开工", priority: "high" } })).rejects.toThrow();
  const got = await api.issue.get({ id: made.id });
  expect([got.title, got.priority, got.status]).toEqual(["带着改动开工", "high", "backlog"]);
});

test("a todo dragged onto another goes before it", async ({ page, api }) => {
  const first = await issue(api, "排先后甲");
  const second = await issue(api, "排先后乙");
  await page.goto("/issues");
  const todo = lane(page, "待办");
  await todo.getByRole("button", { name: "排先后乙" }).dragTo(todo.getByRole("button", { name: "排先后甲" }));
  await expect
    .poll(async () => {
      const ids = (await api.issue.history.list()).map((r) => r.issue.id);
      return ids.indexOf(second.id) < ids.indexOf(first.id);
    })
    .toBe(true);
});

test("the search keeps only the cards it matches", async ({ page, api }) => {
  await issue(api, "搜索要找到的苹果");
  await issue(api, "搜索不该出现的香蕉");
  await page.goto("/issues");
  const todo = lane(page, "待办");
  await expect(todo.getByRole("button", { name: "搜索不该出现的香蕉" })).toBeVisible();
  await page.getByRole("textbox", { name: "找工单" }).fill("苹果");
  await expect(todo.getByRole("button", { name: "搜索要找到的苹果" })).toBeVisible();
  await expect(todo.getByRole("button", { name: "搜索不该出现的香蕉" })).toHaveCount(0);
  await page.getByRole("button", { name: "清掉筛选" }).click();
  await expect(todo.getByRole("button", { name: "搜索不该出现的香蕉" })).toBeVisible();
});

test("screenshots of the board and of an issue", async ({ page, api }) => {
  const fox = await api.agent.create(helper("阿狐", "fox"));
  const rabbit = await api.agent.create(helper("小兔", "rabbit"));
  const project = await api.project.create({ name: "farm-site" });
  await issue(api, "首页的农场地图在窄屏上会挤成一团", { priority: "urgent", project: project.name, assignee: fox.id });
  await issue(api, "给工单加上验收标准的模板", { priority: "high", project: project.name, assignee: rabbit.id });
  await issue(api, "设置页的语音开关不生效", { priority: "low", project: project.name });
  const shown = await issue(api, "把登录页的「记住我」做完", {
    priority: "medium",
    project: project.name,
    assignee: fox.id,
    description: "登录页已经有「记住我」的勾选框，但没有接上：\n\n- 勾上时把会话存 30 天\n- 不勾时关掉浏览器就登出",
  });
  await api.issue.update({ id: shown.id, criteria: ["勾上后重开浏览器还登着", "不勾时关掉浏览器就登出"] });

  await page.goto("/issues");
  await expect(lane(page, "待办").getByRole("button", { name: "首页的农场地图在窄屏上会挤成一团" })).toBeVisible();
  await page.getByRole("combobox", { name: "按项目看" }).selectOption("farm-site");
  await expect(page.getByText(/^4 \/ \d+ 张$/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("board.png") });

  await page.setViewportSize({ width: 600, height: 800 });
  await page
    .getByRole("group", { name: "看哪一列" })
    .getByRole("button", { name: /处理中/ })
    .click();
  await expect(lane(page, "处理中")).toBeVisible();
  await expect(lane(page, "待办")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("narrow.png") });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole("group", { name: "看法" }).getByRole("button", { name: "列表" }).click();
  await expect(page.getByRole("region", { name: "待办" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("list.png") });
  await page.getByRole("group", { name: "看法" }).getByRole("button", { name: "看板" }).click();

  await page.goto(`/issues/${shown.id}`);
  await expect(page.getByRole("dialog", { name: "工单" }).getByRole("textbox", { name: "标题" })).toHaveValue("把登录页的「记住我」做完");
  await page.screenshot({ path: test.info().outputPath("detail.png") });
});
