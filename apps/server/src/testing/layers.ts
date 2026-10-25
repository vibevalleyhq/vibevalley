// What tests run the services on: a configuration in a temporary home and an in-memory database.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer } from "effect";
import { defaults, Settings, type Config } from "../base/config.ts";
import { Database } from "../base/db.ts";

export function testConfig(change: Partial<Config> = {}): Config {
  const home = mkdtempSync(join(tmpdir(), "vibevalley-test-"));
  const config = defaults(home);
  // Every listener on a free port: two farms in tests (or worktrees) never take each other's 8787, 8788, 8790.
  return {
    ...config,
    home,
    workRoot: join(home, "work"),
    db: "memory",
    port: 0,
    voice: { ...config.voice, line: { ...config.voice.line, port: 0 } },
    lan: { ...config.lan, port: 0 },
    ...change,
  };
}

export const testSettings = (change: Partial<Config> = {}) => Layer.succeed(Settings, testConfig(change));

export const testDatabase = (change: Partial<Config> = {}) => Database.pipe(Layer.provide(testSettings(change)));
