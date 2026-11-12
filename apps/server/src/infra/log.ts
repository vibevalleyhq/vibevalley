import { isAbort } from "@vibevalley/async";

export type Level = "debug" | "info" | "warn" | "error";

/** Where the server's lines go: each says its level and the module that wrote it. A test gives one that keeps the lines. */
export interface Logger {
  readonly debug: (...message: readonly unknown[]) => void;
  readonly info: (...message: readonly unknown[]) => void;
  readonly warn: (...message: readonly unknown[]) => void;
  readonly error: (...message: readonly unknown[]) => void;
  /** The same lines, said by a part of this one (issue → issue/dispatch). */
  readonly child: (name: string) => Logger;
}

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** A line's words: an Error by its stack (or message), anything else as text. */
const wordsOf = (m: unknown): string =>
  m instanceof Error ? (m.stack ?? `${m.name}: ${m.message}`) : typeof m === "string" ? m : (JSON.stringify(m) ?? String(m));

export interface LoggerOptions {
  readonly name: string;
  /** Lines below it are not written. Default info. */
  readonly level?: Level;
  /** Where a line goes. Default: the console, errors and warnings to stderr. */
  readonly write?: (level: Level, name: string, line: string) => void;
}

const toConsole = (level: Level, name: string, line: string) => {
  // oxlint-disable-next-line vibevalley/no-wall-clock -- a log line says when it was written, whatever a test's clock says
  const text = `[${new Date().toISOString()}] ${level.toUpperCase()} (${name}): ${line}`;
  // oxlint-disable-next-line no-console -- the one place the server writes its log
  if (level === "error" || level === "warn") console.error(text);
  // oxlint-disable-next-line no-console -- the one place the server writes its log
  else console.log(text);
};

export function makeLogger(options: LoggerOptions): Logger {
  const least = order[options.level ?? "info"];
  const write = options.write ?? toConsole;
  const say =
    (level: Level) =>
    (...message: readonly unknown[]) => {
      if (order[level] >= least) write(level, options.name, message.map(wordsOf).join(" "));
    };
  return {
    debug: say("debug"),
    info: say("info"),
    warn: say("warn"),
    error: say("error"),
    child: (name) => makeLogger({ ...options, name: `${options.name}/${name}` }),
  };
}

/** A logger that keeps what it is told, for a test to read. */
export function keptLog(name = "test"): Logger & { readonly lines: readonly { readonly level: Level; readonly name: string; readonly line: string }[] } {
  const lines: { level: Level; name: string; line: string }[] = [];
  const log = makeLogger({ name, level: "debug", write: (level, n, line) => void lines.push({ level, name: n, line }) });
  return Object.assign(log, { lines });
}

/** Work the caller goes on without: a failure is logged at warn after what (the words say what was being done), and the
 * caller carries on. An abort is not a failure: it goes on up. */
export async function bestEffort(log: Logger, what: string, work: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
  try {
    await work();
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    log.warn(what, e);
  }
}
