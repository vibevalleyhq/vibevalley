// What the command line writes and how it ends, for an agent as much as a person: stdout holds the result and nothing
// else (one JSON document, or one JSON line per frame of a stream), stderr the progress, the help on a mistake and the
// failure as JSON with what to do next; the exit code says which kind of failure it was without reading the words.
// Everything goes through Effect's Stdio, so a test gives the command line its own.

import { Effect, Option, Schema, Stdio, Stream } from "effect";

/** Exit codes a script can branch on. */
export const exit = {
  ok: 0,
  /** The server failed, or something else unexpected. */
  other: 1,
  /** The command was written wrong: an unknown flag, a missing argument, a body its endpoint does not take. */
  usage: 2,
  /** The server refused (ApiError Refused). */
  refused: 3,
  /** The server found no such thing (ApiError Missing). */
  missing: 4,
  /** No server to talk to. */
  unreachable: 5,
  /** Stopped by Ctrl+C (SIGINT), as a shell reports it. */
  interrupted: 130,
} as const;

/** One thing to do next: what to do, and, when it is a command, the words to run (without the program's name). */
export interface Next {
  readonly say: string;
  readonly run?: readonly string[];
}

const NextStep: Schema.Codec<Next> = Schema.Struct({ say: Schema.String, run: Schema.optionalKey(Schema.Array(Schema.String)) });

/** A command that did not go through, as it is printed: `{"error": {...}}` on stderr. */
export class Failure extends Schema.TaggedError<Failure, { readonly brand: unique symbol }>()("Failure", {
  code: Schema.Int,
  /** ApiError's tag (Refused, Missing…), the parser's (MissingArgument…), or Unreachable, InvalidJson, Server. */
  tag: Schema.String,
  text: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  next: Schema.optionalKey(Schema.Array(NextStep)),
}) {}

const line = (to: "stdout" | "stderr", text: string) =>
  Effect.flatMap(Stdio.Stdio, (io) => Stream.run(Stream.make(text + "\n"), io[to]({ endOnDone: false }))).pipe(Effect.orDie);

export const out = (text: string) => line("stdout", text);
export const err = (text: string) => line("stderr", text);

/** What stdin holds, to its end. */
export const stdinText = Effect.flatMap(Stdio.Stdio, (io) => io.stdin.pipe(Stream.decodeText, Stream.mkString));

/** A document as stdout takes it: laid out for a person on a terminal, one line otherwise. */
const printDocument = (value: unknown) =>
  Effect.flatMap(Stdio.Stdio, (io) => io.stdoutIsTerminal).pipe(Effect.flatMap((tty) => out(tty ? JSON.stringify(value, null, 2) : JSON.stringify(value))));

const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** An answer's body as a document; one that is not JSON goes as it came. */
export const printBody = (text: string) => (text.trim() === "" ? Effect.void : Option.match(json(text), { onNone: () => out(text), onSome: printDocument }));

/** The failure on stderr, always one line, so a script can read the last line as JSON. */
export const printFailure = (f: Failure) =>
  err(
    JSON.stringify({
      error: { tag: f.tag, message: f.text, ...(f.status !== undefined ? { status: f.status } : {}), ...(f.next && f.next.length > 0 ? { next: f.next } : {}) },
    }),
  );
