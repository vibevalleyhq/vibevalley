// The command line run in a test: against the whole farm on a free port, with a Stdio of its own and no environment.

import { ConfigProvider, Effect, Layer, Sink, Stdio, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { run } from "../cli.ts";
import { app } from "../http/app.ts";
import { testConfig } from "./layers.ts";

/** The whole farm on a free port; the command line is pointed at it. */
export const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a))));
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
    const code = yield* run(args).pipe(
      Effect.provide(io),
      Effect.provide([NodeServices.layer, FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))]),
    );
    [out, err] = [out.replace(/\n$/, ""), err.replace(/\n$/, "")];
    const last = err.split("\n").at(-1) ?? "";
    const failure = last.startsWith('{"error"')
      ? (
          JSON.parse(last) as {
            error: { tag: string; message: string; next?: { say: string; run?: string[] }[] };
          }
        ).error
      : undefined;
    return { code, out, err, failure };
  });
