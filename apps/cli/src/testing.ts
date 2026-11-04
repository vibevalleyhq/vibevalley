// The command line run in a test: in the process, with a Stdio of its own and no environment, pointed at a whole farm
// (@vibevalley/server/testing).

import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import { TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { run } from "./main.ts";

export { farm, lookIn, memoriesOf, workingFarm } from "@vibevalley/server/testing";

/** The failure stderr ends with (output.ts's printFailure). */
const failureOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        tag: Schema.String,
        message: Schema.String,
        status: Schema.optionalKey(Schema.Int),
        next: Schema.optionalKey(Schema.Array(Schema.Struct({ say: Schema.String, run: Schema.optionalKey(Schema.Array(Schema.String)) }))),
      }),
    }),
  ),
);

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
    const failure = Option.getOrUndefined(Option.map(failureOf(last), (f) => f.error));
    return { code, out, err, failure };
  });
