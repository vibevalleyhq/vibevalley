// The command line run in a test: against the whole farm on a free port, with a Stdio of its own and no environment.

import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Sink, Stdio, Stream } from "effect";
import { TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { run } from "@/cli.ts";
import { app } from "@/http/app.ts";
import { registryOf } from "@/runtime/runtime.ts";

import { testConfig } from "./layers.ts";
import { helper, installedOnly } from "./worker.ts";
import { quietApp } from "./world.ts";

/** The whole farm on a free port; the command line is pointed at it. */
export const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return "http://" + address;
});

/** The same with the test helper as its only runtime (pi, testing/worker.ts), so an issue can be worked from the command
 * line as an agent would. */
export const workingFarm = Effect.gen(function* () {
  let address = "";
  const given = [helper()];
  const runtime = { registry: registryOf(given), probe: installedOnly(given), background: false };
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), { ...quietApp, runtime }));
  return "http://" + address;
});

const text = (chunk: string | Uint8Array) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));

/** One run, with a Stdio of its own and no environment: its exit code, what it put on stdout and on stderr, and the
 * failure stderr ends with. */
export const cli = (args: string[], stdin = "", env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    let out = "";
    let err = "";
    const io = Stdio.layerTest({
      stdout: () => Sink.forEach((c: string | Uint8Array) => Effect.sync(() => void (out += text(c)))),
      stderr: () => Sink.forEach((c: string | Uint8Array) => Effect.sync(() => void (err += text(c)))),
      stdin: Stream.make(new TextEncoder().encode(stdin)),
      stdoutIsTerminal: Effect.succeed(false),
    });
    // Colour read from this Stdio and env, not the process's: under `vp run` the process has FORCE_COLOR.
    const code = yield* run(args).pipe(
      Effect.provide(TerminalCapabilities.layer.pipe(Layer.provideMerge(io))),
      Effect.provide([NodeServices.layer, FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))]),
    );
    [out, err] = [out.replace(/\n$/u, ""), err.replace(/\n$/u, "")];
    const last = err.split("\n").at(-1) ?? "";
    const failure = last.startsWith('{"error"')
      ? (JSON.parse(last) as { error: { tag: string; message: string; next?: { say: string; run?: string[] }[] } }).error
      : undefined;
    return { code, out, err, failure };
  });
