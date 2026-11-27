/** Check that a pending SQLite write cannot stall project navigation in GPUI. */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import { ShellStateSchema, VdpWsClient, waitForVdpEndpoint } from "./vdp-client.ts";

const ProjectRow = z.object({ id: z.union([z.number(), z.string()]) });

async function regressionOpenProjectWhileAnotherConnectionHoldsStore(
  binary: string,
  rootPath: string,
  action: "activate_path" | "new_terminal_at",
): Promise<void> {
  mkdirSync(rootPath, { recursive: true });
  const root = realpathSync(rootPath);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home);
  const dbPath = join(root, "state.db");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("VIBEVALLEY_") && !/(?:API_KEY|TOKEN|PASSWORD|SECRET)/u.test(key)) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: home,
    SHELL: "/bin/sh",
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_STORE: dbPath,
    VIBEVALLEY_WORK_ROOT: root,
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_NO_OPENING: "1",
    VIBEVALLEY_TEST_RUNTIMES: "1",
    VIBEVALLEY_DEBUG_PORT: "0",
  });

  // The first VDP draw runs after the host has opened and migrated state.db.
  const app = spawn(binary, [], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  app.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const timeout = setTimeout(() => {
    app.kill("SIGKILL");
  }, 60_000);

  let writer: DatabaseSync | undefined;
  let client: VdpWsClient | undefined;
  let acquired = false;
  let released = false;

  try {
    const exitPromise = new Promise<number>((resolveExit, rejectExit) => {
      if (app.exitCode !== null) {
        resolveExit(app.exitCode);
        return;
      }
      app.once("error", rejectExit);
      app.once("exit", (status, signal) => resolveExit(status ?? (signal ? 1 : 0)));
    });

    const endpoint = await waitForVdpEndpoint({
      homeDir: home,
      ...(app.pid !== undefined ? { expectedPid: app.pid } : {}),
      timeoutMs: 25_000,
      appExited: () => app.exitCode,
    });
    client = await VdpWsClient.connect(endpoint, 15_000);

    const loadDeadline = Date.now() + 20_000;
    let loaded = false;
    while (Date.now() < loadDeadline) {
      const state = await client.callDecoded("Shell.getState", {}, ShellStateSchema);
      if (state.loaded) {
        loaded = true;
        break;
      }
      await sleep(50);
    }
    if (!loaded) {
      throw new Error(`${action}: host never reported loaded=true\n${stderr}`);
    }

    writer = new DatabaseSync(dbPath);
    await client.call("Page.draw", {});
    writer.exec("BEGIN IMMEDIATE");
    acquired = true;
    await client.call("Shell.dispatchAction", { action: { type: action, path: project } });
    await client.call("Page.draw", {});
    writer.exec("ROLLBACK");
    released = true;
    await client.call("Shell.save", {});
    await client.call("Shell.quit", {});
    client.close();
    client = undefined;

    const code = await exitPromise;

    if (code !== 0 || !acquired || !released) {
      throw new Error(`${action}: host did not paint while another writer held state.db (exit=${code})\n${stderr}`);
    }

    // A synchronous load reaches its busy timeout and falls back to a
    // transient project before the second draw can release the lock.
    const rowRaw = writer.prepare("SELECT id FROM projects WHERE path = ?").get(realpathSync(project));
    if (rowRaw === undefined) {
      throw new Error(`${action}: project was not persisted after releasing the lock`);
    }
    const row = ProjectRow.parse(rowRaw);
    console.log(`${action}: next draw released the competing writer and project ${String(row.id)} persisted`);
  } finally {
    clearTimeout(timeout);
    client?.close();
    if (app.exitCode === null) {
      app.kill("SIGKILL");
    }
    writer?.close();
  }
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true });
  const binaryArg = positionals[0];
  if (!binaryArg) {
    throw new Error("Usage: verify-workspace-store.ts <binary>");
  }
  const binary = realpathSync(resolve(binaryArg));
  const temp = mkdtempSync(join(tmpdir(), "vv-host-store-"));
  try {
    for (const action of ["activate_path", "new_terminal_at"] as const) {
      await regressionOpenProjectWhileAnotherConnectionHoldsStore(binary, join(temp, action), action);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
