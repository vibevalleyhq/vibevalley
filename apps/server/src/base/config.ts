// The server's configuration: the defaults, then the YAML file, then the environment
// (VIBEVALLEY_ and the key, dots as underscores: session.stall_seconds is VIBEVALLEY_SESSION_STALL_SECONDS). A key not in
// the defaults is never read from the environment. The keys are snake_case in the file and the environment, camelCase here.

import { homedir } from "node:os";
import { join } from "node:path";
import { Config as Keys, ConfigProvider, Context, Data, Effect, FileSystem, Schema } from "effect";
import { parse } from "yaml";

export interface Config {
  /** VIBEVALLEY_HOME, or ~/.vibevalley; the YAML file is in it, so it cannot be set there. */
  readonly home: string;
  readonly version: string;
  /** The farm's own folder: projects/<name> are its projects, worktrees/ the issues' worktrees. */
  readonly workRoot: string;
  /** Empty: home/db; "memory" keeps it in memory; anything else is the database's folder. */
  readonly db: string;
  readonly port: number;
  /** The built page (apps/web/dist), served at / beside the API. Empty: no page. */
  readonly web: string;
  readonly agent: { readonly model: string };
  /** Read from DEEPSEEK_API_KEY, AGORA_APP_ID and AGORA_APP_CERTIFICATE too. A key saved in the app wins. */
  readonly deepseek: { readonly apiKey: string };
  readonly agora: { readonly appId: string; readonly appCertificate: string };
  readonly voice: { readonly id: string; readonly line: { readonly port: number; readonly url: string } };
  readonly lan: { readonly port: number };
  /** Commits by these emails count as yours too; in the environment, comma-separated. */
  readonly gitEmails: readonly string[];
  /** The tokei binary; empty: found on PATH. */
  readonly tokei: string;
  readonly cnyPerUsd: number;
  /** 0 or less: no patrol. */
  readonly patrol: { readonly heartbeatMinutes: number };
  /** 0 or less: looked at every millisecond. */
  readonly recurrence: { readonly tickMs: number };
  /** stallSeconds: quiet this long, a session is shown as stuck; trajectoryDays: a gone session's steps are deleted after it (0 or less keeps them). */
  readonly session: { readonly stallSeconds: number; readonly trajectoryDays: number };
  readonly project: { readonly maxSessions: number; readonly checkTimeoutSeconds: number };
  readonly github: { readonly prProjects: readonly string[]; readonly prPollSeconds: number };
  readonly chat: { readonly noticeBatchMs: number; readonly retryWakeMs: number };
  /** An OTLP collector (http://127.0.0.1:4318): the spans, logs and metrics go there; none when empty. */
  readonly otlp: { readonly url: string };
}

export const noticeBatchMs = 3_000;

export function defaults(home = homedir()): Config {
  return {
    home: join(home, ".vibevalley"),
    version: "0.1.0",
    workRoot: join(home, "vibevalley-dev"),
    db: "",
    port: 8787,
    web: "",
    agent: { model: "" },
    deepseek: { apiKey: "" },
    agora: { appId: "", appCertificate: "" },
    voice: { id: "", line: { port: 8788, url: "" } },
    lan: { port: 8790 },
    gitEmails: [],
    tokei: "",
    cnyPerUsd: 7.2,
    patrol: { heartbeatMinutes: 10 },
    recurrence: { tickMs: 20_000 },
    session: { stallSeconds: 240, trajectoryDays: 30 },
    project: { maxSessions: 3, checkTimeoutSeconds: 1200 },
    github: { prProjects: [], prPollSeconds: 180 },
    chat: { noticeBatchMs, retryWakeMs: 3_000 },
    otlp: { url: "" },
  };
}

/** Why the configuration cannot be read: the file, or a key's value. */
export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

const port = (name: string, value: number) => Keys.Int(name).pipe(Keys.withDefault(value));
const text = (name: string, value: string) => Keys.String(name).pipe(Keys.withDefault(value));
const number = (name: string, value: number) => Keys.Finite(name).pipe(Keys.withDefault(value));
/** A list: comma-separated in the environment, a list in the file. */
const list = (name: string) =>
  Keys.Array(Schema.String, name).pipe(
    Keys.map((all) => all.map((s) => s.trim()).filter((s) => s !== "")),
    Keys.withDefault<readonly string[]>([]),
  );

/** Every key but home and version, by its snake_case name, with its default (d). */
const keys = (d: Config) =>
  Keys.all({
    workRoot: text("work_root", d.workRoot),
    db: text("db", d.db),
    port: port("port", d.port),
    web: text("web", d.web),
    agent: Keys.nested(Keys.all({ model: text("model", d.agent.model) }), "agent"),
    deepseek: Keys.nested(Keys.all({ apiKey: text("api_key", d.deepseek.apiKey) }), "deepseek"),
    agora: Keys.nested(Keys.all({ appId: text("app_id", d.agora.appId), appCertificate: text("app_certificate", d.agora.appCertificate) }), "agora"),
    voice: Keys.nested(
      Keys.all({
        id: text("id", d.voice.id),
        line: Keys.nested(Keys.all({ port: port("port", d.voice.line.port), url: text("url", d.voice.line.url) }), "line"),
      }),
      "voice",
    ),
    lan: Keys.nested(Keys.all({ port: port("port", d.lan.port) }), "lan"),
    gitEmails: list("git_emails"),
    tokei: text("tokei", d.tokei),
    cnyPerUsd: number("cny_per_usd", d.cnyPerUsd),
    patrol: Keys.nested(Keys.all({ heartbeatMinutes: number("heartbeat_minutes", d.patrol.heartbeatMinutes) }), "patrol"),
    recurrence: Keys.nested(Keys.all({ tickMs: number("tick_ms", d.recurrence.tickMs) }), "recurrence"),
    session: Keys.nested(
      Keys.all({ stallSeconds: number("stall_seconds", d.session.stallSeconds), trajectoryDays: number("trajectory_days", d.session.trajectoryDays) }),
      "session",
    ),
    project: Keys.nested(
      Keys.all({
        maxSessions: number("max_sessions", d.project.maxSessions),
        checkTimeoutSeconds: number("check_timeout_seconds", d.project.checkTimeoutSeconds),
      }),
      "project",
    ),
    github: Keys.nested(Keys.all({ prProjects: list("pr_projects"), prPollSeconds: number("pr_poll_seconds", d.github.prPollSeconds) }), "github"),
    chat: Keys.nested(
      Keys.all({ noticeBatchMs: number("notice_batch_ms", d.chat.noticeBatchMs), retryWakeMs: number("retry_wake_ms", d.chat.retryWakeMs) }),
      "chat",
    ),
    otlp: Keys.nested(Keys.all({ url: text("url", d.otlp.url) }), "otlp"),
  });

const expandHome = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** The YAML file: a record of keys, or nothing when it is optional and not there. */
const readFile = Effect.fnUntraced(function* (path: string, optional: boolean) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* Effect.orElseSucceed(fs.exists(path), () => false))) {
    if (optional) return undefined;
    return yield* new ConfigError({ message: `${path}: 没有这个文件` });
  }
  const body = yield* Effect.mapError(fs.readFileString(path), (e) => new ConfigError({ message: `${path}: ${e.message}` }));
  return yield* Effect.try({
    try: (): unknown => parse(body),
    catch: (e) => new ConfigError({ message: `${path}: ${e instanceof Error ? e.message : String(e)}` }),
  });
});

/** file: the YAML to read, which must be there; empty is home/vibevalley.yaml, read if it is there. The environment wins
 * over the file: VIBEVALLEY_<KEY>, then the other services' own names (DEEPSEEK_API_KEY…). */
export const loadConfig = Effect.fnUntraced(function* (
  file: string = "",
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.fn.Return<Config, ConfigError, FileSystem.FileSystem> {
  const base = defaults();
  const home = env.VIBEVALLEY_HOME || base.home;
  const optional = file === "";
  const path = optional ? join(home, "vibevalley.yaml") : file;
  const given = yield* readFile(path, optional);
  const set = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  // A value set empty in the environment is that value: an empty list, no page.
  const fromEnv = ConfigProvider.fromEnv({ env: set, preserveEmptyStrings: true }).pipe(ConfigProvider.nested("VIBEVALLEY"), ConfigProvider.constantCase);
  const ownNames = ConfigProvider.fromUnknown({
    deepseek: { api_key: env.DEEPSEEK_API_KEY },
    agora: { app_id: env.AGORA_APP_ID, app_certificate: env.AGORA_APP_CERTIFICATE },
  });
  const provider = ConfigProvider.orElse(fromEnv, ConfigProvider.orElse(ownNames, ConfigProvider.fromUnknown(given ?? {})));
  const read = yield* Effect.mapError(keys(base).parse(provider), (e) => new ConfigError({ message: `${path}: ${e.message}` }));
  for (const [name, n] of [
    ["port", read.port],
    ["voice.line.port", read.voice.line.port],
    ["lan.port", read.lan.port],
  ] as const) {
    if (n < 0 || n > 65535) return yield* new ConfigError({ message: `${path}: ${name} 不是端口：${n}` });
  }
  if (read.github.prPollSeconds <= 0) return yield* new ConfigError({ message: "github.pr_poll_seconds 必须大于 0" });
  const c: Config = { ...base, ...read, home };
  return { ...c, workRoot: expandHome(c.workRoot), tokei: expandHome(c.tokei), web: expandHome(c.web), db: expandHome(c.db) };
});

/** The database's folder, or "memory". */
export function dbDir(c: Config): string {
  if (c.db === "memory") return "memory";
  if (c.db === "") return join(c.home, "db");
  return c.db;
}

/** The main API and its MCP endpoint share a fixed local identity; remote devices use the separate lan listener. */
export const serverAddress = (c: Config) => `127.0.0.1:${c.port}`;

/** Where the projects are: each folder in it is one. */
export const projectsDir = (c: Config) => join(c.workRoot, "projects");

/** The configuration, as a service. */
export class Settings extends Context.Service<Settings, Config>()("vibevalley/Config") {}
