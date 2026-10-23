// What the command line writes and how it ends, for an agent as much as a person: stdout holds the result and nothing
// else (one JSON document, or one JSON line per frame of a stream), stderr the progress, the help on a mistake and the
// failure as JSON with what to do next; the exit code says which kind of failure it was without reading the words.

import { Data } from "effect";

/** Where the command line reads and writes: the process's, or a test's. */
export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** stdout is a terminal: a document is laid out for a person; otherwise it is one line. */
  readonly tty: boolean;
  readonly stdin: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

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
} as const;

/** One thing to do next: what to do, and, when it is a command, the words to run (without the program's name). */
export interface Next {
  readonly say: string;
  readonly run?: readonly string[];
}

/** A command that did not go through, as it is printed: `{"error": {...}}` on stderr. */
export class Failure extends Data.TaggedError("Failure")<{
  readonly code: number;
  /** ApiError's tag (Refused, Missing…), the parser's (MissingArgument…), or Unreachable, InvalidJson, Server. */
  readonly tag: string;
  readonly text: string;
  readonly status?: number;
  readonly next?: readonly Next[];
}> {}

/** A document as stdout takes it. */
export const document = (value: unknown, tty: boolean) => (tty ? JSON.stringify(value, null, 2) : JSON.stringify(value));

/** An answer's body as a document; one that is not JSON goes as it came. */
export function printBody(io: Io, text: string) {
  if (text.trim() === "") return;
  try {
    io.out(document(JSON.parse(text), io.tty));
  } catch {
    io.out(text);
  }
}

/** The failure on stderr, always one line, so a script can read the last line as JSON. */
export const printFailure = (io: Io, f: Failure) =>
  io.err(
    JSON.stringify({
      error: { tag: f.tag, message: f.text, ...(f.status !== undefined ? { status: f.status } : {}), ...(f.next && f.next.length > 0 ? { next: f.next } : {}) },
    }),
  );
