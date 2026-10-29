// What a message's words become (ui/richText.ts): code with its language, colours, a copy button and a fold; Mermaid
// drawn by Pele with nothing in it that runs; only safe links; #12 to its issue; task lists; long messages folded.

import { expect, test } from "./fixtures";

const ts = ["```ts", ...Array.from({ length: 24 }, (_, i) => `const n${i}: number = ${i};`), "```"].join("\n");
const flow = ["```mermaid", "flowchart LR", "  Owner --> Orchestrator --> Helper", "```"].join("\n");
const broken = ["```mermaid", "flowchart LR", "  A -->", "```"].join("\n");

test("a message's code, diagrams, links and lists", async ({ page, api }) => {
  const general = (await api.channel.list()).find((c) => c.default)!;
  const issue = await api.issue.create({ title: "a referenced issue" });
  await api.channel.message.send({ id: general.id, text: ts });
  await api.channel.message.send({ id: general.id, text: flow });
  await api.channel.message.send({ id: general.id, text: broken });
  await api.channel.message.send({
    id: general.id,
    text: `see #${issue.number} and [x](javascript:alert(1)) and [site](https://example.com)\n\n- [x] done\n- [ ] next`,
  });
  await page.goto("/chat");

  const code = page.locator('[data-testid="code-block"][data-lang="ts"]');
  await expect(code).toHaveAttribute("data-folded", "");
  await expect(code.locator("pre")).toHaveAttribute("data-coloured", "", { timeout: 15_000 });
  await expect(code.locator('pre span[style*="color"]').first()).toBeVisible();
  await expect(code.getByTestId("code-copy")).toBeVisible();
  await code.getByTestId("code-more").click();
  await expect(code).not.toHaveAttribute("data-folded", "");

  const drawn = page.locator('[data-testid="diagram"][data-drawn]');
  await expect(drawn.locator("svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.locator("script, foreignObject, a")).toHaveCount(0);
  await expect(page.locator('[data-testid="diagram"][data-failed]')).toHaveCount(1);

  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(page.getByTestId("message-body").locator('a[href="https://example.com"]')).toHaveAttribute("target", "_blank");
  await expect(page.locator("li.task")).toHaveCount(2);

  await page.locator(`a[href="/issues/${issue.number}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.number}$`));
  await expect(page.getByTestId("desk")).toHaveAttribute("data-place", "issues");
});

test("a long message starts folded and opens whole", async ({ page, api }) => {
  const general = (await api.channel.list()).find((c) => c.default)!;
  await api.channel.message.send({ id: general.id, text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n") });
  await page.goto("/chat");
  const body = page.getByTestId("message-body").filter({ hasText: "line 39" });
  await expect(body).toHaveAttribute("data-folded", "");
  await page.getByTestId("message-more").click();
  await expect(body).not.toHaveAttribute("data-folded", "");
});
