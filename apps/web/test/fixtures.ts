// A real server per worker (apps/server) on a free port with a temporary home and work root, serving
// dist/ at /. Tests drive the page with `page` (its baseURL is the server) and set things up with `api`.

import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type IssueAct, type IssueAction, readStream, type StateFrame, statePath, VibeValleyApi } from "@vibevalley/protocol";

interface Server {
  url: string;
  home: string;
  work: string;
}

// The server and the agents it runs read keys from the environment: a test must never reach a real model, voice service or
// chat bot with the owner's keys, nor read the owner's VIBEVALLEY_* settings. HOME is the test's folder too: the coding agents'
// own logins (~/.pi, ~/.claude, …) stay out of reach.
const secret = /KEY|TOKEN|SECRET|CERTIFICATE|PASSWORD|^AGORA_|^VIBEVALLEY_/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k)));

/** Every built-in template but the default orchestrator's (apps/server/src/agent/templates/index.json): what a test farm
 * starts with, as a farm whose agent.starters names them. */
const starters = () =>
  (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "server", "src", "agent", "templates", "index.json"), "utf8")) as string[])
    .filter((id) => id !== "orchestrator")
    .join(",");

export const test = base.extend<{ api: VibeValleyApi }, { server: Server; farm: string }>({
  // Files that set their own (test.use({ farm: "…" })) run in workers of their own, on a server no other file has used.
  farm: ["shared", { scope: "worker", option: true }],
  server: [
    async ({ farm: _farm }, use) => {
      const dir = mkdtempSync(join(tmpdir(), "vibevalley-web-"));
      const home = join(dir, "home");
      const work = join(dir, "work");
      // Set by global-setup.ts, whose environment the workers inherit.
      const out = process.env.VIBEVALLEY_TEST_OUT!;
      // Without the model's key: the orchestrator answers that it has none, and no test reaches a real model.
      const env = {
        ...cleanEnv(),
        HOME: dir,
        VIBEVALLEY_HOME: home,
        VIBEVALLEY_WORK_ROOT: work,
        VIBEVALLEY_PORT: "0",
        VIBEVALLEY_LAN_PORT: "0",
        VIBEVALLEY_VOICE_LINE_PORT: "0",
        // This machine's coding agents are not asked: pi is the scripted helper, doing what the words of its job say
        // (apps/server/src/testing/helper.ts), and no other runtime is installed.
        VIBEVALLEY_TEST_RUNTIMES: "1",
        VIBEVALLEY_AGENT_STARTERS: starters(),
      };
      const args = ["--ready-json", "--web", join(out, "dist")];
      const child: ChildProcess = spawn("node", ["--import", "tsx", "src/main.ts", ...args], {
        cwd: join(import.meta.dirname, "..", "..", "server"),
        env,
        stdio: ["ignore", "pipe", "inherit"],
      });
      const url = await new Promise<string>((resolve, reject) => {
        child.once("exit", (code) => reject(new Error(`server exited (${code})`)));
        createInterface({ input: child.stdout! }).on("line", (line) => {
          try {
            const ready = JSON.parse(line) as { url?: string };
            if (ready.url) resolve(ready.url);
          } catch {
            // not the ready line
          }
        });
      });
      await use({ url, home, work });
      child.kill("SIGTERM");
    },
    { scope: "worker" },
  ],
  // An error that escapes the page fails the test: Solid stops updating the whole page after one (REACTIVITY_HALTED), so
  // the page would go on looking alive. On CI the page's console errors also go to the job's log.
  page: async ({ page }, use) => {
    const escaped: string[] = [];
    page.on("pageerror", (e) => {
      escaped.push(e.message);
      if (process.env.VIBEVALLEY_WEB_DEV === "1") console.log(`[page stack] ${e.stack}`);
      if (process.env.CI) console.log(`[page] ${e.message}`);
    });
    if (process.env.CI)
      page.on("console", (m) => {
        if (m.type() === "error") console.log(`[page] ${m.text()}`);
      });
    // On Solid's development build (vp run e2e:dev), what it warns of goes to the run's output, each untracked read
    // with the stack that made it: the warning alone names no file.
    if (process.env.VIBEVALLEY_WEB_DEV === "1")
      await page.addInitScript(() => {
        const warn = console.warn.bind(console);
        console.warn = (...a: unknown[]) => warn(...a, String(a[0]).includes("STRICT_READ") ? new Error().stack : "");
      });
    if (process.env.VIBEVALLEY_WEB_DEV === "1")
      page.on("console", (m) => {
        if (m.type() === "warning" || m.type() === "error") console.log(`[solid ${m.type()}] ${m.text().replaceAll("\n", " ⏎ ")}`);
      });
    await use(page);
    expect(escaped, "errors that escaped the page").toEqual([]);
  },
  baseURL: async ({ server }, use) => use(server.url),
  api: async ({ server }, use) => use(new VibeValleyApi(server.url)),
});

export { expect };

/** The page as a screenshot should catch it: fonts in, every image decoded, two frames drawn. What a picture waits for,
 * not a while (the tests do not wait by the clock: scripts/oxlint-plugin.ts). A scene that moves on with time is moved
 * through with page.clock instead. */
export async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** A tab by what it is (its data-key), not by what it says. */
export const tab = (scope: Page | Locator, key: string) => scope.locator(`[role="tab"][data-key="${key}"]`);

/** The workbench composer's field once the composer is on this channel: typed into earlier, a draft is replaced by the
 * channel's own when it comes. */
export async function composerOn(scope: Page | Locator, channel: string) {
  await expect(scope.getByTestId("composer")).toHaveAttribute("data-key", channel);
  return scope.getByTestId("composer").getByTestId("composer-input");
}

/** A gate a route waits at until the test opens it: a slow server is slow until the test has seen what it wanted. */
export function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open: () => open() };
}

/** The farm's default channel's id: "" when the frame names none. */
export async function defaultChannel(api: VibeValleyApi): Promise<string> {
  const abort = new AbortController();
  const frame = await new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(api.base + statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e: unknown) => abort.signal.aborted || reject(e));
  });
  return frame.state.chat?.channels.find((c) => c.default)?.id ?? "";
}

/** An issue's buttons by name, as the server sends them (Issue.attention.acts). */
export const buttons = (...names: IssueAct[]): IssueAction[] =>
  names.map((act): IssueAction => {
    switch (act) {
      case "tell":
      case "answer":
        return { act, does: "say" };
      case "stop":
        return { act, does: "stop" };
      case "complete":
      case "acknowledge":
        return { act, does: "move", status: "done", words: "none" };
      case "close":
        return { act, does: "move", status: "canceled", words: "none" };
      case "reject":
      case "reopen":
        return { act, does: "move", status: "todo", words: "required" };
      case "start":
      case "cure":
      case "resolve":
      case "resume":
        return { act, does: "move", status: "todo", words: "none" };
    }
  });

/** Picks a value in the workbench's Select (ui/Field.tsx): its button opens the list, the option is found by its value. */
export async function choose(trigger: Locator, value: string) {
  await trigger.click();
  await trigger.page().locator(`[role="option"][data-value="${value}"]`).click();
  await expect(trigger).toHaveAttribute("data-value", value);
}
