import { access, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { defaultHome } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";
import { Secret } from "@vibevalley/protocol/schema";

import { messageOf } from "#/base/errors.ts";

export interface ServerConfig {
  /** VIBEVALLEY_HOME, or ~/.vibevalley; the YAML file is in it, so it cannot be set there. */
  readonly home: string;
  readonly version: string;
  /** The space's own folder: repos/<name> are its repositories, worktrees/ the issues' worktrees, pkm/ the notes. */
  readonly workRoot: string;
  /** PGlite's folder when database.url is empty. Empty: home/db. "memory" keeps it in memory. */
  readonly db: string;
  /** A Postgres to keep the farm in (postgres://…); empty: PGlite in db. It may hold a password, so it is a secret. */
  readonly database: { readonly url: Secret };
  readonly port: number;
  /** The built page (apps/web/dist), served at / beside the API. Empty: no page. */
  readonly web: string;
  /** starters: the built-in templates a new farm installs beside its default orchestrator, by id, in order; in the
   * environment, comma-separated. */
  readonly agent: { readonly model: string; readonly starters: readonly string[] };
  /** Read from DEEPSEEK_API_KEY, AGORA_APP_ID and AGORA_APP_CERTIFICATE too. A key saved in the app wins. */
  readonly deepseek: { readonly apiKey: Secret };
  readonly agora: { readonly appId: string; readonly appCertificate: Secret };
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
  readonly cron: { readonly tickMs: number };
  /** stallSeconds: quiet this long, a session is shown as stuck; trajectoryDays: a gone session's steps are deleted after it (0 or less keeps them). */
  readonly session: { readonly stallSeconds: number; readonly trajectoryDays: number };
  readonly repo: { readonly maxSessions: number; readonly checkTimeoutSeconds: number };
  readonly github: { readonly prRepos: readonly string[]; readonly prPollSeconds: number };
  readonly chat: { readonly noticeBatchMs: number; readonly retryWakeMs: number };
  /** An OTLP collector (http://127.0.0.1:4318): the spans, logs and metrics go there; none when empty. */
  readonly otlp: { readonly url: string };
  /** The notes' vault (pkm/): its PARA folders and journals. Empty: <workRoot>/pkm. */
  readonly pkm: { readonly root: string };
}

const noticeBatchMs = 3_000;

export function defaults(home = homedir()): ServerConfig {
  return {
    home: defaultHome("", home),
    version: "0.1.0",
    workRoot: join(home, "vibevalley-dev"),
    db: "",
    database: { url: new Secret("") },
    port: 8787,
    web: "",
    agent: { model: "", starters: [] },
    deepseek: { apiKey: new Secret("") },
    agora: { appId: "", appCertificate: new Secret("") },
    voice: { id: "", line: { port: 8788, url: "" } },
    lan: { port: 8790 },
    gitEmails: [],
    tokei: "",
    cnyPerUsd: 7.2,
    patrol: { heartbeatMinutes: 10 },
    cron: { tickMs: 20_000 },
    session: { stallSeconds: 240, trajectoryDays: 30 },
    repo: { maxSessions: 3, checkTimeoutSeconds: 1200 },
    github: { prRepos: [], prPollSeconds: 180 },
    chat: { noticeBatchMs, retryWakeMs: 3_000 },
    otlp: { url: "" },
    pkm: { root: "" },
  };
}

/** Why the configuration cannot be read: the file, or a key's value. */
class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const expandHome = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

type Kind = "text" | "path" | "secret" | "int" | "number" | "list";

/** Every key but home and version: where it goes in ServerConfig, its snake_case path in the file (and so its
 * VIBEVALLEY_A_B name in the environment), and how its value is read. */
const keys: readonly { readonly at: readonly string[]; readonly name: readonly string[]; readonly kind: Kind }[] = [
  { at: ["workRoot"], name: ["work_root"], kind: "path" },
  { at: ["db"], name: ["db"], kind: "path" },
  { at: ["database", "url"], name: ["database", "url"], kind: "secret" },
  { at: ["port"], name: ["port"], kind: "int" },
  { at: ["web"], name: ["web"], kind: "path" },
  { at: ["agent", "model"], name: ["agent", "model"], kind: "text" },
  { at: ["agent", "starters"], name: ["agent", "starters"], kind: "list" },
  { at: ["deepseek", "apiKey"], name: ["deepseek", "api_key"], kind: "secret" },
  { at: ["agora", "appId"], name: ["agora", "app_id"], kind: "text" },
  { at: ["agora", "appCertificate"], name: ["agora", "app_certificate"], kind: "secret" },
  { at: ["voice", "id"], name: ["voice", "id"], kind: "text" },
  { at: ["voice", "line", "port"], name: ["voice", "line", "port"], kind: "int" },
  { at: ["voice", "line", "url"], name: ["voice", "line", "url"], kind: "text" },
  { at: ["lan", "port"], name: ["lan", "port"], kind: "int" },
  { at: ["gitEmails"], name: ["git_emails"], kind: "list" },
  { at: ["tokei"], name: ["tokei"], kind: "path" },
  { at: ["cnyPerUsd"], name: ["cny_per_usd"], kind: "number" },
  { at: ["patrol", "heartbeatMinutes"], name: ["patrol", "heartbeat_minutes"], kind: "number" },
  { at: ["cron", "tickMs"], name: ["cron", "tick_ms"], kind: "number" },
  { at: ["session", "stallSeconds"], name: ["session", "stall_seconds"], kind: "number" },
  { at: ["session", "trajectoryDays"], name: ["session", "trajectory_days"], kind: "number" },
  { at: ["repo", "maxSessions"], name: ["repo", "max_sessions"], kind: "number" },
  { at: ["repo", "checkTimeoutSeconds"], name: ["repo", "check_timeout_seconds"], kind: "number" },
  { at: ["github", "prRepos"], name: ["github", "pr_repos"], kind: "list" },
  { at: ["github", "prPollSeconds"], name: ["github", "pr_poll_seconds"], kind: "number" },
  { at: ["chat", "noticeBatchMs"], name: ["chat", "notice_batch_ms"], kind: "number" },
  { at: ["chat", "retryWakeMs"], name: ["chat", "retry_wake_ms"], kind: "number" },
  { at: ["otlp", "url"], name: ["otlp", "url"], kind: "text" },
  { at: ["pkm", "root"], name: ["pkm", "root"], kind: "path" },
];

/** The keys that also have a name of their own in the environment. */
const ownNames: Readonly<Record<string, string>> = {
  "deepseek.api_key": "DEEPSEEK_API_KEY",
  "agora.app_id": "AGORA_APP_ID",
  "agora.app_certificate": "AGORA_APP_CERTIFICATE",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const inFile = (file: unknown, name: readonly string[]): unknown => {
  let at: unknown = file;
  for (const part of name) at = isRecord(at) ? at[part] : undefined;
  return at;
};

/** A value as the key's kind reads it; a string from the environment and a value from the file both. */
function valueOf(kind: Kind, raw: unknown, where: string): unknown {
  switch (kind) {
    case "text":
    case "path":
    case "secret": {
      if (typeof raw !== "string" && typeof raw !== "number") throw new ConfigError(`${where}: not text`);
      const text = String(raw);
      return kind === "path" ? expandHome(text) : kind === "secret" ? new Secret(text) : text;
    }
    case "int":
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n) || (kind === "int" && !Number.isInteger(n)))
        throw new ConfigError(`${where}: not a ${kind === "int" ? "whole number" : "number"}`);
      return n;
    }
    case "list": {
      const all = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw.map(String) : undefined;
      if (all === undefined) throw new ConfigError(`${where}: not a list`);
      return all.map((s) => s.trim()).filter((s) => s !== "");
    }
    default:
      return kind satisfies never;
  }
}

/** into with value set at the path; each object on the way is copied, so the defaults' own are never changed. */
const setAt = (into: Record<string, unknown>, at: readonly string[], value: unknown): void => {
  const [head, ...rest] = at;
  if (head === undefined) return;
  if (rest.length === 0) {
    into[head] = value;
    return;
  }
  const child = isRecord(into[head]) ? { ...into[head] } : {};
  setAt(child, rest, value);
  into[head] = child;
};

/** The YAML file: a record of keys, or nothing when it is optional and not there. */
async function readYaml(path: string, optional: boolean): Promise<unknown> {
  const there = await access(path).then(
    () => true,
    () => false,
  );
  if (!there) {
    if (optional) return undefined;
    throw new ConfigError(t("server.base.noFile", { path }));
  }
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (e) {
    throw new ConfigError(`${path}: ${messageOf(e)}`, { cause: e });
  }
  try {
    return parse(body) as unknown;
  } catch (e) {
    throw new ConfigError(`${path}: ${messageOf(e)}`, { cause: e });
  }
}

const isPort = (n: number) => Number.isInteger(n) && n >= 0 && n <= 65_535;

/** file: the YAML to read, which must be there. empty is home/vibevalley.yaml, read if it is there. The environment wins
 * over the file (a value set empty there is that value: an empty list, no page), the file over the defaults. */
export async function loadConfig(file = "", env: Readonly<Record<string, string | undefined>> = process.env): Promise<ServerConfig> {
  const base = defaults();
  const home = env.VIBEVALLEY_HOME || base.home;
  const optional = file === "";
  const path = optional ? join(home, "vibevalley.yaml") : file;
  const given = await readYaml(path, optional);
  const read: Record<string, unknown> = { ...base };
  for (const key of keys) {
    const dotted = key.name.join(".");
    const envName = `VIBEVALLEY_${key.name.map((n) => n.toUpperCase()).join("_")}`;
    const own = ownNames[dotted];
    const fromEnv = env[envName] ?? (own === undefined ? undefined : env[own]);
    const raw = fromEnv ?? inFile(given, key.name);
    if (raw === undefined || raw === null) continue;
    setAt(read, key.at, valueOf(key.kind, raw, fromEnv !== undefined ? envName : `${path}: ${dotted}`));
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key above set a value of its kind over the defaults' own
  const config = { ...(read as unknown as ServerConfig), home };
  for (const [name, n] of [
    ["port", config.port],
    ["voice.line.port", config.voice.line.port],
    ["lan.port", config.lan.port],
  ] as const) {
    if (!isPort(n)) throw new ConfigError(t("server.base.notPort", { path, name, port: n }));
  }
  if (!(config.github.prPollSeconds > 0)) throw new ConfigError(t("server.base.prPoll"));
  return config;
}

export const pkmDir = (c: ServerConfig) => c.pkm.root || join(c.workRoot, "pkm");

/** This computer's name as people say it: its host name without .local. */
export const hostName = () => hostname().replace(/\.local$/u, "") || "vibevalley";

/** The database's folder, or "memory". */
export function dbDir(c: ServerConfig): string {
  if (c.db === "memory") return "memory";
  if (c.db === "") return join(c.home, "db");
  return c.db;
}

/** The main API and its MCP endpoint share a fixed local identity; remote devices use the separate lan listener. */
export const serverAddress = (c: ServerConfig) => `127.0.0.1:${c.port}`;

/** Where the space's repositories are: each folder in it is one. */
export const reposDir = (c: ServerConfig) => join(c.workRoot, "repos");

/** Where the issues' worktrees are: <repo>.<issue number> under it. */
export const worktreesDir = (c: ServerConfig) => join(c.workRoot, "worktrees");

/** A profile's folder for conversation logs, archives and evals; memory rows live in the database. */
export const agentHome = (c: ServerConfig, agent: string) => join(c.home, "agent", agent);
