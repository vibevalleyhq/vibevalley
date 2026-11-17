import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Locator, Page } from "@playwright/test";

import { type Issue, type IssueAct, type IssueAction, readStream, type SessionId, type StateFrame, statePath, VibeValleyApi } from "@vibevalley/protocol";
import { apiSuccessEnvelope } from "@vibevalley/protocol/api";

import { test as base, expect } from "./browser";

interface Server {
  url: string;
  home: string;
  work: string;
}

// The server and the agents it runs read keys from the environment.
const secret = /KEY|TOKEN|SECRET|CERTIFICATE|PASSWORD|^AGORA_|^VIBEVALLEY_|^VIBE_|^MYGO_|^GIT_CONFIG_|^GOROOT$/u;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k)));

const builtinStarters = ["backend", "tester", "frontend", "docs", "scout", "night", "claude", "codex", "lab", "slides", "collector", "pages", "reviewer"];

let fallbackBinDir: string | undefined;
let cachedServerBin: string | undefined;

function ensureServerBinary(out: string | undefined): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const prebuilt = out ? join(out, "bin", `vibe-server${exe}`) : undefined;
  if (prebuilt && existsSync(prebuilt)) return prebuilt;
  if (cachedServerBin && existsSync(cachedServerBin)) return cachedServerBin;
  fallbackBinDir ??= mkdtempSync(join(tmpdir(), "vibevalley-web-bin-"));
  const bin = join(fallbackBinDir, `vibe-server${exe}`);
  const root = join(import.meta.dirname, "..", "..", "..");
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, CGO_ENABLED: "0" };
  delete buildEnv.GOROOT;
  execFileSync("go", ["build", "-o", bin, "./cmd/vibe-server"], { cwd: root, env: buildEnv, stdio: "inherit" });
  cachedServerBin = bin;
  return bin;
}

export const test = base.extend<{ api: VibeValleyApi }, { server: Server; farm: string }>({
  // Files that set their own (test.use({ farm: "…" })) run in workers of their own, on a server no other file has used.
  farm: ["shared", { scope: "worker", option: true }],
  server: [
    async ({ farm: _farm }, use) => {
      const dir = mkdtempSync(join(tmpdir(), "vibevalley-web-"));
      const home = join(dir, "home");
      const work = join(dir, "work");
      mkdirSync(home, { recursive: true });
      mkdirSync(work, { recursive: true });
      // Set by global-setup.ts, whose environment the workers inherit.
      const out = process.env.VIBEVALLEY_TEST_OUT;
      const serverBin = ensureServerBinary(out);
      // Without the model's key: the orchestrator answers that it has none, and no test reaches a real model.
      const env = {
        ...cleanEnv(),
        HOME: dir,
        VIBEVALLEY_HOME: home,
        VIBEVALLEY_WORK_ROOT: work,
        // This machine's coding agents are not asked.
        VIBEVALLEY_TEST_RUNTIMES: "1",
        VIBEVALLEY_LAN_PORT: "0",
        VIBEVALLEY_AGENT_STARTERS: builtinStarters.join(","),
      };
      const distDir = out ? join(out, "dist") : join(import.meta.dirname, "..", "dist");
      const args = [
        "--addr",
        "127.0.0.1:0",
        "--preview-addr",
        "127.0.0.1:0",
        "--db",
        join(home, "vibevalley.db"),
        "--work-root",
        work,
        "--ready-json",
        "--web",
        distDir,
      ];
      const child: ChildProcess = spawn(serverBin, args, {
        cwd: dir,
        env,
        stdio: ["ignore", "pipe", "inherit"],
      });
      const url = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const onExit = (code: number | null) => {
          if (!settled) {
            settled = true;
            reject(new Error(`server exited (${code})`));
          }
        };
        child.once("exit", onExit);
        const lines = createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          try {
            const ready = JSON.parse(line) as { url?: string };
            if (ready.url && !settled) {
              settled = true;
              child.off("exit", onExit);
              lines.close();
              resolve(ready.url);
            }
          } catch {
            // not the ready line
          }
        });
      });
      try {
        await use({ url, home, work });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGTERM");
          await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ server }, use) => use(server.url),
  api: async ({ server }, use) => use(new VibeValleyApi(server.url)),
});

export { expect };

/** The page as a screenshot should catch it: fonts in, every image decoded, two frames drawn. */
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
    readStream(api.base, statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e: unknown) => abort.signal.aborted || reject(e));
  });
  return frame.state.chat?.channels.find((c) => c.default)?.id ?? "";
}

/** An issue's buttons by name, as the server sends them (Issue.stage.acts). */
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

export function withIssueSession(issue: Issue, session: SessionId, agent = "lab"): Issue {
  const current = issue.assignments.findLast((assignment) => assignment.endedAt === undefined);
  const execution = { kind: "worker" as const, session, startedAt: Date.now() };
  return {
    ...issue,
    assignments: current
      ? issue.assignments.map((assignment) =>
          assignment.id === current.id ? { ...assignment, executions: [...assignment.executions, execution] } : assignment,
        )
      : [...issue.assignments, { id: `fixture-${session}`, issue: issue.id, agent, assignedAt: Date.now(), executions: [execution] }],
  };
}

/** Picks a value in the workbench's Select (ui/Field.tsx): its button opens the list, the option is found by its value. */
export async function choose(trigger: Locator, value: string) {
  await trigger.click();
  await trigger.page().locator(`[role="option"][data-key="${value}"]`).click();
  await expect(trigger).toHaveAttribute("data-value", value);
}

export async function replyData<A>(response: { json(): Promise<unknown> }, schema: Parameters<typeof apiSuccessEnvelope<A, unknown>>[0]): Promise<A> {
  return apiSuccessEnvelope(schema).parse(await response.json()).data;
}
