/** Check that a pending SQLite write cannot stall project navigation in GPUI. */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { z } from "zod";

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
  const steps = join(root, "steps.jsonl");
  const commands = [{ shell: "draw" }, { type: action, path: project }, { shell: "draw" }, { shell: "save" }, { shell: "quit" }] as const;
  writeFileSync(steps, commands.map((command) => JSON.stringify(command)).join("\n") + "\n");

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
    VIBEVALLEY_DEBUG_SCRIPT: steps,
  });

  // The first debug step runs after the host has opened and migrated state.db.
  const writer = new DatabaseSync(dbPath);
  const app = spawn(binary, [], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  const timeout = setTimeout(() => {
    app.kill("SIGKILL");
  }, 60_000);

  let acquired = false;
  let released = false;
  const cmd0 = JSON.stringify(commands[0]);
  const cmd2 = JSON.stringify(commands[2]);

  try {
    if (app.stderr !== null) {
      const rl = createInterface({ input: app.stderr });
      for await (const line of rl) {
        if (!line.startsWith("debug script:")) continue;
        if (line.includes(cmd0) && !acquired) {
          writer.exec("BEGIN IMMEDIATE");
          acquired = true;
        } else if (line.includes(cmd2) && !released) {
          writer.exec("ROLLBACK");
          released = true;
        }
      }
    }

    const code = await new Promise<number>((resolveExit, rejectExit) => {
      if (app.exitCode !== null) {
        resolveExit(app.exitCode);
        return;
      }
      app.once("error", rejectExit);
      app.once("exit", (status, signal) => resolveExit(status ?? (signal ? 1 : 0)));
    });

    if (code !== 0 || !acquired || !released) {
      throw new Error(`${action}: host did not paint while another writer held state.db`);
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
    if (app.exitCode === null) {
      app.kill("SIGKILL");
    }
    writer.close();
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
