import "../polyfill";
import { expect, open, test } from "nsh/test";

import { SCENARIO_NOW } from "../fixtures/scenarios";

test("all workbench controls, overlays, rich blocks, virtual-clock hooks, and domain widgets verify cleanly", async () => {
  const app = await open("./components.story.tsx", {
    width: 1200,
    height: 900,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
  });
  const clock = app.clock;
  if (!clock) throw new Error("components.test.tsx requires a manual virtual clock");

  expect(app.texts()).toContain("clicks:0");
  await app.press("id:btn-plain");
  await app.press("id:btn-primary");
  await app.press("id:btn-danger");
  await app.press("id:icon-btn");
  await expect(app.press("id:btn-disabled")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(app.texts()).toContain("clicks:4");

  await app.press("id:confirm-btn");
  expect(app.texts()).toContain("确定删除？");
  await app.press("id:confirm-btn-sure");
  expect(app.texts()).toContain("confirmed:1");

  await app.press("id:confirm-esc");
  expect(app.texts()).toContain("确认撤销？");
  await app.keyboard.press("escape");
  expect(app.texts()).not.toContain("确认撤销？");
  expect(app.texts()).toContain("escConfirmed:0");

  await app.press("id:chk-toggle");
  expect(app.texts()).toContain("checked:true");
  await expect(app.press("id:chk-disabled")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });

  expect(app.texts()).toContain("3");
  expect(app.texts()).toContain("0");
  await app.press("id:seg-mode-b");
  expect(app.texts()).toContain("seg:b");
  expect(app.texts()).toContain("toggles:false/true");
  await app.press("id:comp-toggle-labeled");
  await app.press("id:comp-toggle-bare");
  expect(app.texts()).toContain("toggles:true/false");
  await app.press("id:tab-t2");
  expect(app.texts()).toContain("tab:t2");

  expect(app.texts()).toContain("已就绪");
  expect(app.texts()).toContain("已失败");
  expect(app.texts()).toContain("等待确认");
  expect(app.texts()).toContain("同步中");
  expect(app.texts()).toContain("已归档");
  expect(app.count("id:comp-page-body")).toBe(1);
  expect(app.count("id:list-row-row-a")).toBe(1);
  expect(app.count("id:list-row-row-b")).toBe(1);

  await app.clear("id:field-input");
  await app.type("id:field-input", "updated");
  expect(app.texts()).toContain("field:updated");

  await app.type("label:标签输入", "nsh,");
  expect(app.texts()).toContain("chips:rust,nsh");

  await app.press("id:slider-bump");
  expect(app.texts()).toContain("slider:50");

  await app.press("label:移除 DeepSeek Key");
  expect(app.texts()).toContain("removing:true");

  await app.press("id:open-dialog");
  expect(app.count("id:comp-dialog")).toBe(1);
  await app.press("id:close-dialog");
  expect(app.count("id:comp-dialog")).toBe(0);

  await app.press("id:comp-more");
  await app.press("id:more-rename");
  expect(app.texts()).toContain("menu:rename");

  await app.press("id:fire-toast");
  expect(app.count("id:toast")).toBe(1);
  expect(app.texts()).toContain("保存组件配置成功");
  await clock.fastForward(4_100);
  expect(app.count("id:toast")).toBe(0);

  expect(app.count("id:comp-table >> id:table-row")).toBe(2);
  await app.press("id:comp-table >> id:table-sort-score");
  await app.press("id:comp-table >> id:table-select-page");
  expect(app.texts()).toContain("暂无数据");

  expect(app.texts()).toContain("组件 Markdown");
  expect(app.count("id:long-code-section >> id:code-block")).toBe(1);
  await app.press("id:long-code-section >> text:展开");
  expect(app.texts()).toContain("收起");
  await app.press("id:long-code-section >> id:code-copy");
  expect(app.clipboard()).toContain("export const line20 = 20;");
  await clock.fastForward(1_600);
  expect(app.count("id:long-code-section >> text:已复制")).toBe(0);

  expect(app.texts()).toContain("settled:alpha");
  await app.press("id:bump-settled");
  await clock.fastForward(100);
  expect(app.texts()).toContain("settled:alpha");
  await clock.fastForward(200);
  expect(app.texts()).toContain("settled:beta");

  const momentBefore = app.texts().find((s) => s.startsWith("moment:"));
  expect(momentBefore).toBeDefined();

  await app.press("id:toggle-pose");
  expect(app.texts()).toContain("pose:walk");
  await clock.fastForward(65_000);
  const textsAfter = app.texts();
  expect(textsAfter).toContain("ago:1 分钟前");
  expect(textsAfter.some((s) => s.includes("1 分") && s.includes("进行中"))).toBe(true);
  expect(textsAfter).toContain("模型钥匙未配置");
  expect(app.count("id:subagent-progress")).toBe(1);
});
