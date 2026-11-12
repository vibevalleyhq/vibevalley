import type { Clock } from "@vibevalley/async";

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

export interface FailureFields {
  readonly code: number;
  /** ApiError's kind (Refused, Missing…), the parser's (MissingArgument…), or Unreachable, InvalidJson, Server. */
  readonly tag: string;
  readonly text: string;
  readonly bizCode?: number;
  readonly status?: number;
  readonly next?: readonly Next[];
}

/** A command that did not go through, as it is printed: `{"error": {...}}` on stderr. */
export class Failure extends Error implements FailureFields {
  override readonly name = "Failure";
  readonly code: number;
  readonly tag: string;
  readonly text: string;
  readonly bizCode?: number;
  readonly status?: number;
  readonly next?: readonly Next[];

  constructor(f: FailureFields) {
    super(f.text);
    this.code = f.code;
    this.tag = f.tag;
    this.text = f.text;
    if (f.bizCode !== undefined) this.bizCode = f.bizCode;
    if (f.status !== undefined) this.status = f.status;
    if (f.next !== undefined) this.next = f.next;
  }

  /** Its fields, to make another failure from with some changed. */
  fields(): FailureFields {
    return {
      code: this.code,
      tag: this.tag,
      text: this.text,
      ...(this.bizCode !== undefined ? { bizCode: this.bizCode } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.next !== undefined ? { next: this.next } : {}),
    };
  }
}

/** The conversation ended with this exit code; it has said what it had to on the terminal itself. */
export class Ended extends Error {
  override readonly name = "Ended";
  readonly code: number;
  constructor(code: number) {
    super(`ended with ${code}`);
    this.code = code;
  }
}

/** What a run of the command line reads and writes: the process's own in main.ts, a test's own in testing.ts. */
export interface Io {
  /** Writes text as it is (no newline added). */
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** What stdin holds, to its end. */
  readonly stdin: () => Promise<string>;
  readonly stdoutIsTerminal: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  /** What time it is, and waiting (the retries and polls between tries; a sleep rejects once its signal aborts). */
  readonly clock: Clock;
  /** Aborted by Ctrl+C: every request and wait of the run lets go. */
  readonly signal: AbortSignal;
}

export const out = (io: Io, text: string) => io.stdout(text + "\n");
export const err = (io: Io, text: string) => io.stderr(text + "\n");

/** Optional stdin input for commands that fall back to empty text when stdin cannot be read. */
export const stdinTextOrEmpty = async (io: Io): Promise<string> => {
  try {
    return await io.stdin();
  } catch {
    // No stdin to read (closed, or not a stream): the command goes on as if it were empty, which it then says.
    return "";
  }
};

/** A value as JSON text, one line (as JSON.stringify writes it) or, laid out, indented by two. */
export const jsonText = (value: unknown, layout: "line" | "laidOut" = "line"): string => {
  try {
    // JSON.stringify answers undefined for undefined itself: written as null, as a document always is something.
    return JSON.stringify(value, undefined, layout === "laidOut" ? 2 : undefined) ?? "null";
  } catch (e) {
    throw new Failure({ code: exit.other, tag: "InvalidJson", text: e instanceof Error ? e.message : String(e) });
  }
};

/** An answer's body as a document: laid out for a person on a terminal, one line otherwise; one that is not JSON goes as it came. */
export const printBody = (io: Io, text: string) => {
  if (text.trim() === "") return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON (an answer in plain words): printed as it came.
    return out(io, text);
  }
  out(io, jsonText(value, io.stdoutIsTerminal ? "laidOut" : "line"));
};

/** The failure on stderr, always one line, so a script can read the last line as JSON. */
export const printFailure = (io: Io, f: Failure) =>
  err(
    io,
    jsonText({
      error: {
        ...(f.bizCode !== undefined ? { bizCode: f.bizCode } : {}),
        tag: f.tag,
        message: f.text,
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.next && f.next.length > 0 ? { next: f.next } : {}),
      },
    }),
  );
