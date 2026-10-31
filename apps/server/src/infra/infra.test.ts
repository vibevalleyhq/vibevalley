import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";
import { waitFor } from "@vibevalley/testkit/until";

import { keptFile } from "./files.ts";
import { announce, announced, HomeTaken, leaseHome } from "./lease.ts";

describe("a kept file", () => {
  it.effect("is saved whole at once, written soon after the first change with the later ones joining, and last as its scope closes", () =>
    Effect.gen(function* () {
      const path = join(tempDir("vibevalley-files-"), "deep", "state.json");
      const read = () => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const kept = yield* keptFile(path, { soonMs: 100 });
          yield* kept.save("one");
          expect(read()).toBe("one");
          let state = "two";
          kept.soon(() => state);
          state = "three";
          yield* TestClock.adjust(100);
          yield* waitFor(Effect.sync(read), (text) => text === "three", "the soon write");
          kept.soon(() => "last");
        }),
      );
      expect(read()).toBe("last");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

test("one server per home; a stale lock is taken over", () => {
  const home = tempDir("vibevalley-lease-");
  const release = leaseHome(home);
  expect(() => leaseHome(home)).toThrow(HomeTaken);
  release();
  const again = leaseHome(home);
  again();
  writeFileSync(join(home, ".vibevalley.lock"), "999999");
  leaseHome(home)();
});

test("a server says where it listens in its home while it runs, and a stopped one's word is not taken", () => {
  const home = tempDir("vv-announce-");
  expect(announced(home)).toBeUndefined();
  const withdraw = announce(home, "http://127.0.0.1:56048");
  expect(announced(home)).toBe("http://127.0.0.1:56048");
  withdraw();
  expect(announced(home)).toBeUndefined();
  // Left behind by a server that died: its pid is not running.
  writeFileSync(join(home, "server.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 2 ** 22 + 7 }));
  expect(announced(home)).toBeUndefined();
});
