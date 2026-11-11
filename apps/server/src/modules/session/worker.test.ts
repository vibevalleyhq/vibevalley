import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { workerAccess } from "./worker.ts";

it.effect("regression: credential files are private, rotated and removed with their scope", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const stub = { ...spawner, exitCode: () => Effect.succeed(ChildProcessSpawner.ExitCode(0)) };
    let file = "";
    yield* Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* workerAccess;
        const first = yield* cli.prepare("w1", "http://127.0.0.1:1/mcp", "first");
        const previous = /--worker-access-file '([^']+)'/u.exec(first.command)?.[1] ?? "";
        expect(statSync(previous).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(previous)).mode & 0o777).toBe(0o700);
        const second = yield* cli.prepare("w1", "http://127.0.0.1:1/mcp", "second");
        file = /--worker-access-file '([^']+)'/u.exec(second.command)?.[1] ?? "";
        expect(file).not.toBe(previous);
        expect(existsSync(previous)).toBe(false);
        expect(existsSync(file)).toBe(true);
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub)),
    );
    expect(existsSync(file)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
