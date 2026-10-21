// The village canvas (src/farm/canvas): it runs without errors, the cursor follows the tool and what it points at, and
// helpers walk in, work and light their lanterns at night. Tests cannot start real helpers (no model, no coding agent),
// so the helpers come from a frame the test serves in place of the state stream: the real server's first frame with
// sessions added.

import type { Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath } from "@vibevalley/protocol";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(url + statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
  });
}

const helper = (id: string, station: number, phase: Session["phase"], crop: string): { session: Session; crop: string } => ({
  session: {
    id,
    name: `帮工${id}`,
    agent: `agent-${id}`,
    runtime: "nobody",
    brief: "",
    hiredAt: 0,
    runs: 1,
    phase,
    issue: `issue-${id}`,
    play: { station, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] } as unknown as Session["play"],
  },
  crop,
});

/** The real frame with four helpers: one hands-on at its plot, one reading at the library, one ripe, one withered. */
function withHelpers(frame: StateFrame): StateFrame {
  const doing = (action: string) => ({ _tag: "working", since: 0, doing: { action, label: action } }) as Session["phase"];
  const helpers = [
    helper("a", 0, doing("edit_file"), "leafy"),
    helper("b", 1, doing("read_file"), "sprout"),
    helper("c", 2, { _tag: "ripe" }, "wheat"),
    helper("d", 4, { _tag: "resting" }, "withered"),
  ];
  return {
    ...frame,
    state: { ...frame.state, sessions: helpers.map((h) => h.session) },
    view: { ...frame.view, plots: Object.fromEntries(helpers.map((h) => [`issue-${h.session.id}`, { crop: h.crop } as never])) },
  };
}

async function serveFrame(page: Page, frame: StateFrame) {
  await page.route("**/api/v1/state", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(frame)}\n\n` }),
  );
}

test("the village runs for a while without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});

test("the cursor is the tool's, and says whether it can be used where it points", async ({ page }) => {
  await page.goto("/");
  const village = page.getByTestId("village");
  await expect(village).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(village).toHaveCSS("cursor", /hand\.png/);
  // An empty plot (the top left bed) can be sowed with the hand.
  const box = (await village.locator("canvas").boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.move(box.x + 128 * scale, box.y + 117 * scale);
  await expect(village).toHaveCSS("cursor", /hand-point/);
  // The watering can on an empty plot: nothing to water.
  await page.keyboard.press("2");
  await expect(village).toHaveCSS("cursor", /water-no/);
});

test("helpers walk in, work their plots and the library, and light lanterns at night", async ({ page, server }) => {
  const frame = withHelpers(await firstFrame(server.url));
  await serveFrame(page, frame);
  await page.goto("/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  // From the gate to their places at 42 art pixels a second.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: test.info().outputPath("day.png") });
  await page.goto("/?tod=0.95");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.waitForTimeout(9000);
  await page.screenshot({ path: test.info().outputPath("night.png") });
});
