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

/** The conversation ended with this exit code; it has said what it had to on the terminal itself. */
export class Ended extends Schema.TaggedError<Ended, { readonly brand: unique symbol }>()("Ended", {
  code: Schema.Finite,
}) {}

const line = (to: "stdout" | "stderr", text: string) =>
  Effect.flatMap(Stdio.Stdio, (io) => Stream.run(Stream.make(text + "\n"), io[to]({ endOnDone: false }))).pipe(Effect.ignore({ log: "Debug" }));

export const out = (text: string) => line("stdout", text);
export const err = (text: string) => line("stderr", text);

/** What stdin holds, to its end. */
export const stdinText = Effect.flatMap(Stdio.Stdio, (io) => io.stdin.pipe(Stream.decodeText, Stream.mkString));

/** Optional stdin input for commands that fall back to empty text when stdin cannot be read, recording the cause at debug level. */
export const stdinTextOrEmpty = stdinText.pipe(
  Effect.tapError((e) => Effect.logDebug("stdin could not be read", e)),
  Effect.orElseSucceed(() => ""),
);

const oneLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const laidOut = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

/** A value as JSON text, one line (as JSON.stringify writes it) or, laid out, indented by two. */
export const jsonText = (value: unknown, layout: "line" | "laidOut" = "line") =>
  (layout === "laidOut" ? laidOut : oneLine)(value).pipe(Effect.mapError((e) => Failure.make({ code: exit.other, tag: "InvalidJson", text: e.message })));

/** A document as stdout takes it: laid out for a person on a terminal, one line otherwise. */
const printDocument = Effect.fnUntraced(function* (value: unknown) {
  const io = yield* Stdio.Stdio;
  const tty = yield* io.stdoutIsTerminal;
  const text = yield* jsonText(value, tty ? "laidOut" : "line");
  return yield* out(text);
});

const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** An answer's body as a document; one that is not JSON goes as it came. */
export const printBody = (text: string) => (text.trim() === "" ? Effect.void : Option.match(json(text), { onNone: () => out(text), onSome: printDocument }));

/** The failure on stderr, always one line, so a script can read the last line as JSON. */
export const printFailure = Effect.fnUntraced(function* (f: Failure) {
  const text = yield* jsonText({
    error: { tag: f.tag, message: f.text, ...(f.status !== undefined ? { status: f.status } : {}), ...(f.next && f.next.length > 0 ? { next: f.next } : {}) },
  });
  return yield* err(text);
});
