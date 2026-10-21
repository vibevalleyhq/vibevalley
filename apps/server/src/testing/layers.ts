// What tests run the services on: a configuration in a temporary home and an in-memory database.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer } from "effect";
import { defaults, Settings, type Config } from "../base/config.ts";
import { Database } from "../base/db.ts";

export function testConfig(change: Partial<Config> = {}): Config {
  const home = mkdtempSync(join(tmpdir(), "vibevalley-test-"));
  return { ...defaults(home), home, workRoot: join(home, "work"), db: "memory", ...change };
}

export const testSettings = (change: Partial<Config> = {}) => Layer.succeed(Settings, testConfig(change));

export const testDatabase = (change: Partial<Config> = {}) => Database.pipe(Layer.provide(testSettings(change)));
