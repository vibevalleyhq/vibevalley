// The conversations in a terminal (`vibevalley` alone, `vibevalley runtime chat <runtime>`) are the server's program
// (apps/server src/chat.ts): they need its runtimes, models and config, which this command line does not load. It runs
// that program with the terminal handed over and ends with its exit code. VIBEVALLEY_CHAT names the program (the
// packaged app's launcher sets it to the server's bundle); from the repository it is @vibevalley/server's chat. Either
// runs on this process's own Node, with its loader when there is one (vpx's, for TypeScript).

import { fileURLToPath } from "node:url";

import { Config, Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";

import { exit, Failure } from "./output.ts";

/** The conversation ended with this exit code; it has said what it had to on the terminal itself. */
class Ended extends Schema.TaggedError<Ended, { readonly brand: unique symbol }>()("Ended", { code: Schema.Finite }) {}

/** The server's chat program, or "" when there is none to run. */
const serverChat = () => {
  try {
    return fileURLToPath(import.meta.resolve("@vibevalley/server/chat"));
  } catch {
    return "";
  }
};

const program = Config.String("VIBEVALLEY_CHAT").pipe(
  Config.withDefault(""),
  Config.map((given) => given || serverChat()),
);

/** The server's conversation with these arguments, on this terminal. Uninterruptible: it takes Ctrl+C itself (stop the
 * turn, again to quit), so the signal that reaches this process too must not cut it off. */
export const converse = (args: readonly string[]) =>
  Effect.gen(function* () {
    const chat = yield* program;
    if (!chat) return yield* new Failure({ code: exit.other, tag: "NoChat", text: t("cli.failure.noChat") });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner
      .exitCode(ChildProcess.make(process.execPath, [...process.execArgv, chat, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
      .pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Chat", text: e.message })));
    if (code !== 0) return yield* new Ended({ code });
  }).pipe(Effect.uninterruptible);
