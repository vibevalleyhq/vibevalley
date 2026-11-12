import { expect, test } from "vite-plus/test";

import { keptLog } from "#/infra/log.ts";
import type { MemorySourceConfig } from "#/modules/setting/memorySources.ts";

import { makeSources, type Source } from "./sources.ts";

const quiet = (name: string, more: Partial<Source> = {}): Source => ({
  name,
  unavailable: () => undefined,
  stop: async () => {},
  prefetch: async () => [],
  syncTurn: async () => {},
  sessionEnded: async () => {},
  search: async () => ({ found: [], coverage: "" }),
  list: async () => [],
  add: async () => undefined,
  forget: async () => {},
  can: { list: true, forget: true, transcripts: false },
  ...more,
});

test("an operation a change of sources cuts short fails with why the sources were replaced", async () => {
  let configs: readonly MemorySourceConfig[] = [{ kind: "everos", url: "http://first", enabled: true }];
  const asked = Promise.withResolvers<void>();
  const sources = makeSources({
    local: quiet("local"),
    configured: () => configs,
    build: (c) =>
      quiet(c.kind, {
        forget: () => {
          asked.resolve();
          return new Promise<never>(() => {});
        },
      }),
    log: keptLog(),
  });
  try {
    const forgetting = sources.forget("lab", "everos:m1").then(
      () => undefined,
      (e: unknown) => e,
    );
    await asked.promise;
    configs = [{ kind: "everos", url: "http://second", enabled: true }];
    await sources.info();
    const error = await forgetting;
    expect(error instanceof Error ? error.message : error).toBe("memory sources changed; outside operation canceled");
  } finally {
    await sources.close();
  }
});
