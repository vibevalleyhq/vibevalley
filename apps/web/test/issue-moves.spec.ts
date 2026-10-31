// Moving a card between lanes, as far as the page wires it: the card waits in the lane it was dropped on until a frame
// shows the move, a refusal leaves it there failed, and a retry is the same request (its key). Which frame settles a
// move is base/intent.test.ts's and features/issue/moves.test.ts's.
import type { Page } from "@playwright/test";

import { type Agent, type IssueStatusRequest, pathOf, type VibeValleyApi } from "@vibevalley/protocol";

import { expect, gate, test } from "./fixtures";

test.use({ farm: "issue-moves" });

const fox: Agent = {
  id: "",
  name: "fox",
  role: "helper",
  duty: "",
  enabled: true,
  runtime: "pi",
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
  look: { species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
};

const lane = (page: Page, key: string) => page.locator(`[data-testid="lane"][data-key="${key}"]`);
const card = (page: Page, key: string, id: string) => lane(page, key).locator(`[data-testid="issue-card"][data-key="${id}"]`);

/** A to-do with a helper and a project, so 开工 may send it out. */
async function startable(api: VibeValleyApi, name: string) {
  const helper = await api.agent.create({ ...fox, name });
  const project = await api.project.create({ name });
  return api.issue.create({ title: `the ${name} one`, project: project.name, assignee: helper.id });
}

const statusUpdates = (page: Page) => {
  const sent: IssueStatusRequest[] = [];
  page.on("request", (r) => r.url().endsWith(pathOf("issue.status.update")) && sent.push(r.postDataJSON()));
  return sent;
};

test("a card dropped on 进行中 waits there, moving, until the server has it", async ({ page, api }) => {
  const made = await startable(api, "slow");
  const server = gate();
  await page.route(`**${pathOf("issue.status.update")}`, async (route) => {
    await server.opened;
    await route.continue();
  });
  const sent = statusUpdates(page);
  await page.goto("/issues");
  await card(page, "todo", made.id).dragTo(lane(page, "working"));
  await expect(card(page, "working", made.id)).toHaveAttribute("data-state", "moving");
  await expect(card(page, "todo", made.id)).toHaveCount(0);
  // Frames keep coming while the move waits: an issue written meanwhile shows on the board.
  const meanwhile = await api.issue.create({ title: "written while the move waits" });
  await expect(card(page, "todo", meanwhile.id)).toBeVisible();
  await expect(card(page, "working", made.id)).toHaveAttribute("data-state", "moving");
  // From here to the issue's page the card never shows in 待办 again: no snap back, no jump.
  await page.evaluate((id) => {
    new MutationObserver(() => {
      if (document.querySelector(`[data-testid="lane"][data-key="todo"] [data-testid="issue-card"][data-key="${id}"]`)) document.body.dataset.snapped = "";
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  }, made.id);
  server.open();
  // Sent out, the page opens the issue (TodoDetail's dispatchedNotice); the move was asked for once.
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`, "u"), { timeout: 20_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.requestKey).toBeTruthy();
  await expect(page.locator("body")).not.toHaveAttribute("data-snapped");
});

test("a refused move stays where it was dropped, failed, and a retry sends the same key", async ({ page, api }) => {
  const made = await startable(api, "refused");
  let first = true;
  await page.route(`**${pathOf("issue.status.update")}`, async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ _tag: "Refused", reason: "full" }) });
  });
  const sent = statusUpdates(page);
  await page.goto("/issues");
  await card(page, "todo", made.id).dragTo(lane(page, "working"));
  await expect(card(page, "working", made.id)).toHaveAttribute("data-state", "failed");
  await expect(lane(page, "working").getByTestId("move-failed")).toBeVisible();
  await lane(page, "working").getByTestId("move-retry").click();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`, "u"), { timeout: 20_000 });
  expect(sent).toHaveLength(2);
  expect(sent[1]?.requestKey).toBe(sent[0]?.requestKey);
  expect((await api.issue.get({ id: made.id })).sessions).toHaveLength(1);
});

test("a failed move put back is the frame's card again", async ({ page, api }) => {
  const made = await startable(api, "putback");
  await page.route(`**${pathOf("issue.status.update")}`, (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ _tag: "Refused", reason: "full" }) }),
  );
  await page.goto("/issues");
  await card(page, "todo", made.id).dragTo(lane(page, "working"));
  await expect(card(page, "working", made.id)).toHaveAttribute("data-state", "failed");
  await lane(page, "working").getByTestId("move-put-back").click();
  await expect(card(page, "todo", made.id)).toBeVisible();
  await expect(card(page, "todo", made.id)).not.toHaveAttribute("data-state");
});

test("a status button on the issue's page shows the move on its way until the server has it", async ({ page, api }) => {
  const made = await startable(api, "detail");
  const server = gate();
  await page.route(`**${pathOf("issue.status.update")}`, async (route) => {
    await server.opened;
    await route.continue();
  });
  const sent = statusUpdates(page);
  await page.goto(`/issues/${made.id}`);
  await page.getByTestId("issue-start").click();
  const move = page.getByTestId("issue-move");
  await expect(move).toHaveAttribute("data-state", "moving");
  await expect(page.getByTestId("issue-start")).toBeDisabled();
  server.open();
  await expect(move).toHaveCount(0, { timeout: 20_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.requestKey).toBeTruthy();
});
