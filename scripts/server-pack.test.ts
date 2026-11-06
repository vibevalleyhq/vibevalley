import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

test("regression: server packaging keeps the real server and terminal entrypoints", () => {
  const output = mkdtempSync(join(tmpdir(), "vibevalley-server-pack-"));
  try {
    execFileSync("vp", ["pack", "--out-dir", output, "--sourcemap"], { cwd: join(import.meta.dirname, "../apps/server"), stdio: "pipe" });
    for (const [name, source] of [
      ["main", "src/main.ts"],
      ["chat", "src/chat/main.ts"],
    ]) {
      const map: { sources: string[] } = JSON.parse(readFileSync(join(output, `${name}.mjs.map`), "utf8"));
      expect(map.sources.some((path) => path.endsWith(`/apps/server/${source}`))).toBe(true);
      expect(readFileSync(join(output, `${name}.mjs`), "utf8").length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("regression: bundled server assets resolve inside the deployed server", () => {
  const output = mkdtempSync(join(tmpdir(), "vibevalley-server-assets-"));
  const server = join(import.meta.dirname, "../apps/server");
  try {
    cpSync(join(server, "package.json"), join(output, "package.json"));
    mkdirSync(join(output, "db"));
    cpSync(join(server, "db/migrations"), join(output, "db/migrations"), { recursive: true });
    execFileSync("vp", ["pack", "src/base/assets.ts", "--out-dir", join(output, "dist")], { cwd: server, stdio: "pipe" });
    const resolved = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'import { serverFile } from "./dist/assets.mjs"; process.stdout.write(serverFile("db/migrations/0001_schema.up.sql"))'],
      { cwd: output, encoding: "utf8" },
    );
    expect(readFileSync(resolved, "utf8")).toBe(readFileSync(join(server, "db/migrations/0001_schema.up.sql"), "utf8"));
    expect(resolved).toBe(realpathSync(join(output, "db/migrations/0001_schema.up.sql")));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("regression: source runtime keeps asset directories as directories", () => {
  const server = join(import.meta.dirname, "../apps/server");
  const resolved = execFileSync(
    "vpx",
    ["--input-type=module", "-e", 'import { serverFile } from "@vibevalley/server/assets"; process.stdout.write(serverFile("src/agent/templates"))'],
    { cwd: server, encoding: "utf8" },
  );
  expect(resolved).toBe(realpathSync(join(server, "src/agent/templates")));
});
