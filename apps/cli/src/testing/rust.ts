import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { RunningFarm } from "@vibevalley/server/testing";
import { tempDir } from "@vibevalley/testkit/temp";

/** The Rust server (crates/vibevalley-server's binary) on a home of its own, with the page's tests' stand-in agent: what
 * VIBEVALLEY_SERVER_BIN names runs the command line's tests against it instead of apps/server. */
export async function rustFarm(bin: string): Promise<RunningFarm> {
  const dir = tempDir("vibevalley-cli-");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|^VIBEVALLEY_/u.test(k)));
  // Every built-in profile but the default orchestrator, as apps/server's test farm has them.
  const templates = join(import.meta.dirname, "..", "..", "..", "server", "src", "modules", "agent", "templates", "index.json");
  const starters = (JSON.parse(await readFile(templates, "utf8")) as string[]).filter((id) => id !== "orchestrator").join(",");
  const child: ChildProcess = spawn(bin, ["--ready-json"], {
    cwd: dir,
    env: {
      ...env,
      HOME: dir,
      VIBEVALLEY_HOME: join(dir, "home"),
      VIBEVALLEY_WORK_ROOT: join(dir, "work"),
      VIBEVALLEY_PORT: "0",
      VIBEVALLEY_TEST_RUNTIMES: "1",
      VIBEVALLEY_AGENT_STARTERS: starters,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`vibevalley-server exited (${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const ready = JSON.parse(line) as { url?: string };
        if (ready.url) resolve(ready.url);
      } catch {
        // not the ready line
      }
    });
  });
  return {
    url,
    [Symbol.asyncDispose]: async () => {
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await gone;
    },
  };
}
