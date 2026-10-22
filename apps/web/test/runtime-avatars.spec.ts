import { orchestratorAgent } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.use({ farm: "runtime-avatars" });

test("helper avatars show their actual runtime on cards and small issue rows", async ({ page, api }) => {
  const profiles = await api.agent.list();
  const codex = profiles.find((a) => a.runtime === "codex");
  const claude = profiles.find((a) => a.runtime === "claude");
  if (!codex || !claude) throw new Error("the farm's seed profiles must include Codex and Claude Code");
  for (const a of profiles) if (![orchestratorAgent, codex.id, claude.id].includes(a.id)) await api.agent.delete({ id: a.id });
  await api.issue.create({ body: { title: "Codex 的工单", assignee: codex.id } });
  await api.issue.create({ body: { title: "Claude Code 的工单", assignee: claude.id } });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  for (const [a, name] of [
    [codex, "Codex"],
    [claude, "Claude Code"],
  ] as const) {
    const card = page.locator(`a[href="/agents/${a.id}"]`);
    const badge = card.getByRole("img", { name: `运行工具：${name}`, exact: true });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("title", `运行工具：${name}`);
    await expect(badge.locator("img")).toHaveAttribute("src", `/pixel/logo-${a.runtime}.png`);
    await expect.poll(() => badge.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await badge.locator("xpath=ancestor::*[@aria-hidden='true']").count()).toBe(0);
    const face = await badge.locator("..").boundingBox();
    const mark = await badge.boundingBox();
    if (!face || !mark) throw new Error("the avatar and its runtime mark must have visible bounds");
    expect(mark.x + mark.width / 2).toBeGreaterThan(face.x + face.width / 2);
    expect(mark.y + mark.height / 2).toBeGreaterThan(face.y + face.height / 2);
  }
  const orchestrator = page.getByRole("link", { name: "管家", exact: true });
  await expect(orchestrator).toBeVisible();
  await expect(orchestrator.locator("[data-runtime]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("runtime-avatars-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("runtime-avatars-mobile.png") });

  await page.goto("/issues");
  await page.getByRole("group", { name: "看法" }).getByRole("button", { name: "列表" }).click();
  await page.getByRole("button", { name: "显示", exact: true }).click();
  await page.getByRole("dialog", { name: "显示" }).getByRole("group", { name: "分组" }).getByRole("button", { name: "帮工", exact: true }).click();
  await page.getByRole("button", { name: "显示", exact: true }).click();
  for (const name of ["Codex", "Claude Code"]) await expect(page.getByRole("img", { name: `运行工具：${name}`, exact: true }).first()).toBeVisible();
  const small = page.getByRole("img", { name: "运行工具：Codex", exact: true }).first();
  await expect(small.locator("..")).toHaveCSS("width", "16px");
  await expect(small).toHaveCSS("width", "10px");
  await page.screenshot({ path: test.info().outputPath("runtime-avatars-small-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath("runtime-avatars-small-desktop.png") });
});
