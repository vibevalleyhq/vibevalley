// An artifact (docs/subsystems/artifact.md): its card in the conversation, its page in a sandbox of its own, its
// versions, a reply to one, and the issue it was made for.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

/** A page that tries what an artifact must not do, and writes down what it managed. */
const prying = `<!doctype html><title>probe</title><p id="r">waiting</p><script>
const out = [];
try { localStorage.setItem("x", "1"); out.push("storage"); } catch { out.push("no-storage"); }
try { void parent.document.title; out.push("parent"); } catch { out.push("no-parent"); }
try { void document.cookie; out.push("cookie"); } catch { out.push("no-cookie"); }
fetch("/api/v1/issue/list", { method: "POST", body: "{}" })
  .then(() => out.push("fetch"), () => out.push("no-fetch"))
  .finally(() => { document.getElementById("r").textContent = out.join(","); });
</script>`;

test("an artifact opens from its card in its own sandbox, keeps its versions and takes a reply", async ({ page, api }) => {
  const made = await api.artifact.create({ title: "two layouts", kind: "html", content: prying, note: "first" });
  await page.goto("/chat");
  const card = page.locator(`[data-testid="artifact-card"][data-key="${made.id}"]`);
  await expect(card).toHaveAttribute("data-version", "1");
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/artifacts/${made.id}\\?v=1$`, "u"));
  const shown = page.getByTestId("artifact");
  await expect(shown).toHaveAttribute("data-version", "1");
  const frame = page.getByTestId("artifact-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  await expect(page.frameLocator('[data-testid="artifact-frame"]').locator("#r")).toHaveText("no-storage,no-parent,no-cookie,no-fetch");

  // A new version comes up on its own; the old one is still there to go back to.
  await api.artifact.version.create({ id: made.id, content: "<p id=r>second</p>", note: "second" });
  const versions = page.getByTestId("artifact-versions");
  await expect(versions.locator('[data-key="2"]')).toBeVisible({ timeout: 10_000 });
  await versions.locator('[data-key="2"]').click();
  await expect(shown).toHaveAttribute("data-version", "2");
  await expect(page.frameLocator('[data-testid="artifact-frame"]').locator("#r")).toHaveText("second");
  await versions.locator('[data-key="1"]').click();
  await expect(shown).toHaveAttribute("data-version", "1");

  // A reply goes under the message that said that version.
  await page.getByTestId("artifact-reply").fill("make the drawer wider");
  await page.getByTestId("artifact-send").click();
  const general = (await api.channel.list()).find((c) => c.default)!;
  await expect
    .poll(async () => (await api.channel.message.list({ id: general.id })).find((m) => m.text === "make the drawer wider")?.replyTo)
    .toBe((await api.artifact.get({ id: made.id })).versions[0]!.number);

  const { violations } = await new AxeBuilder({ page }).exclude('[data-testid="artifact-frame"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);

  // Deleted: back to 产出, its cards stay.
  await page.getByTestId("artifact-more").click();
  await page.locator('[role="menuitem"][data-key="delete"]').click();
  await page.getByTestId("artifact-delete-sure").click();
  await expect(page).toHaveURL(/\/artifacts$/u);
  await expect(api.artifact.get({ id: made.id })).rejects.toBeTruthy();
});

test("Markdown handed in is read into blocks to write on, without running the HTML it carries", async ({ page, api }) => {
  const made = await api.artifact.create({
    title: "notes",
    kind: "markdown",
    content: '# heading\n\n<script>window.ran = 1</script><img src=x onerror="window.ran = 2">\n\n- one\n- two',
  });
  expect(made.body).toBe("blocks");
  await page.goto(`/artifacts/${made.id}`);
  const shown = page.getByTestId("artifact-blocks");
  await expect(shown.locator('[data-type="heading"]')).toBeVisible();
  await expect(shown.locator('[data-type="bulleted"]')).toHaveCount(2);
  await expect(shown.locator("script, img")).toHaveCount(0);
  // Every artifact is listed on 产出, whichever way it came.
  await expect(page.locator(`[data-testid="artifact-row"][data-key="${made.id}"]`)).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => (window as unknown as { ran?: number }).ran)).toBeUndefined();
});

test("an issue lists the artifacts made for it", async ({ page, api }) => {
  const issue = await api.issue.create({ title: "an issue with a page" });
  const made = await api.artifact.create({ title: "for the issue", kind: "markdown", content: "done", issue: String(issue.number) });
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByTestId("issue-artifacts").locator(`[data-testid="artifact-card"][data-key="${made.id}"]`)).toBeVisible();
});
