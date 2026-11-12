import { announced, homeOf, savedLocale, signedIn } from "@vibevalley/home";
import { setLocale, t } from "@vibevalley/i18n";

import { type Io, jsonText, out, printBody } from "./output.ts";

// Before any help text is written: the words are in the farm's language.
setLocale(savedLocale(homeOf()));

export const fallbackServer = "http://127.0.0.1:8787";
/** The server signed in to (auth login), else the one using this machine's home (its server.json), else the default port. */
const defaultServer = signedIn(homeOf())?.server ?? announced(homeOf()) ?? fallbackServer;

export type OutputFormat = "text" | "json";
export const outputFormats = ["text", "json"] as const satisfies readonly OutputFormat[];

/** The global flags, read anywhere on the line, with their fallbacks applied. */
export interface Globals {
  /** --server, else VIBEVALLEY_SERVER, else the one signed in to, else the one on this machine. */
  readonly server: string;
  readonly dryRun: boolean;
  readonly format: OutputFormat;
  /** --worker-access-file, else VIBEVALLEY_WORKER_ACCESS_FILE; "" when neither. */
  readonly workerAccessFile: string;
}

/** A global flag as the parser declares it (infra/command.ts). */
export interface GlobalFlag {
  readonly key: keyof Globals;
  readonly flags: string;
  readonly about?: string;
  readonly type?: string;
  readonly choices?: readonly string[];
}

export const ServerFlag: GlobalFlag = {
  key: "server",
  flags: "--server <server>",
  // The rule, not this machine's address: help reads the same everywhere.
  about: t("cli.flag.server", { fallback: fallbackServer }),
  type: "string",
};
export const DryRunFlag: GlobalFlag = { key: "dryRun", flags: "--dry-run", about: t("cli.flag.dryRun") };
export const FormatFlag: GlobalFlag = { key: "format", flags: "--format <format>", about: t("cli.flag.format"), type: "choice", choices: outputFormats };
export const WorkerAccessFlag: GlobalFlag = { key: "workerAccessFile", flags: "--worker-access-file <file>", type: "string" };

const isFormat = (v: unknown): v is OutputFormat => v === "text" || v === "json";

/** The globals from what the parser read (`optsWithGlobals`) and the run's environment. */
export const globalsOf = (given: Readonly<Record<string, unknown>>, io: Io): Globals => {
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    server: text(given.server) ?? (io.env.VIBEVALLEY_SERVER || undefined) ?? defaultServer,
    dryRun: given.dryRun === true,
    format: isFormat(given.format) ? given.format : "text",
    workerAccessFile: text(given.workerAccessFile) ?? io.env.VIBEVALLEY_WORKER_ACCESS_FILE ?? "",
  };
};

/** What a command runs with: the run's io and the global flags. */
export interface Ctx extends Io {
  readonly flags: Globals;
}

export const show = <A>(ctx: Ctx, value: A, text: (value: A) => string) => {
  if (ctx.flags.format === "json") return printBody(ctx, jsonText(value ?? null));
  out(ctx, text(value));
};
