// The server's configuration: the defaults, then the YAML file, then the environment
// (VIBEVALLEY_ and the key, dots as underscores: session.stall_seconds is VIBEVALLEY_SESSION_STALL_SECONDS). A key not in
// the defaults is never read from the environment. The keys are snake_case in the file and the environment, camelCase here.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context } from "effect";
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

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

/** Other services' own names for their keys. */
const ownNames: Readonly<Record<string, string>> = {
  "deepseek.api_key": "DEEPSEEK_API_KEY",
  "agora.app_id": "AGORA_APP_ID",
  "agora.app_certificate": "AGORA_APP_CERTIFICATE",
};

export class ConfigError extends Error {}

/** A value from the file or the environment, as the default's kind: a number, a list (comma-separated from the environment), or text. */
function coerce(key: string, value: unknown, like: unknown, file: string): unknown {
  if (typeof like === "number") {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (!Number.isFinite(n)) throw new ConfigError(`${file}: ${key} 不是数：${String(value)}`);
    return n;
  }
  if (Array.isArray(like)) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") return value === "" ? [] : value.split(",").map((s) => s.trim());
    throw new ConfigError(`${file}: ${key} 要一串`);
  }
  if (typeof value === "object" && value !== null) throw new ConfigError(`${file}: ${key} 不能是一组`);
  return String(value);
}

function merge(
  base: Record<string, unknown>,
  file: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
  prefix: string,
  name: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, like] of Object.entries(base)) {
    const key = prefix + snake(field);
    const given = file?.[snake(field)];
    if (typeof like === "object" && like !== null && !Array.isArray(like)) {
      out[field] = merge(
        like as Record<string, unknown>,
        typeof given === "object" && given !== null ? (given as Record<string, unknown>) : undefined,
        env,
        key + ".",
        name,
      );
      continue;
    }
    let value: unknown = like;
    if (given !== undefined && given !== null) value = coerce(key, given, like, name);
    const fromEnv = env["VIBEVALLEY_" + key.replaceAll(".", "_").toUpperCase()] ?? (ownNames[key] ? env[ownNames[key]] : undefined);
    if (fromEnv !== undefined) value = coerce(key, fromEnv, like, name);
    out[field] = value;
  }
  return out;
}

const expandHome = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** file: the YAML to read, which must be there; empty is home/vibevalley.yaml, read if it is there. */
export function loadConfig(file = "", env: NodeJS.ProcessEnv = process.env): Config {
  const base = defaults();
  const home = env.VIBEVALLEY_HOME || base.home;
  const optional = file === "";
  const path = optional ? join(home, "vibevalley.yaml") : file;
  let given: Record<string, unknown> | undefined;
  if (existsSync(path)) {
    try {
      given = (parse(readFileSync(path, "utf8")) as Record<string, unknown> | null) ?? undefined;
    } catch (e) {
      throw new ConfigError(`${path}: ${(e as Error).message}`);
    }
  } else if (!optional) {
    throw new ConfigError(`${path}: 没有这个文件`);
  }
  const { home: _home, version: _version, ...keys } = base;
  const c = { ...base, ...merge(keys, given, env, "", path), home } as Config;
  for (const [name, port] of [
    ["port", c.port],
    ["voice.line.port", c.voice.line.port],
    ["lan.port", c.lan.port],
  ] as const) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`${path}: ${name} 不是端口：${port}`);
  }
  if (c.github.prPollSeconds <= 0) throw new ConfigError("github.pr_poll_seconds 必须大于 0");
  return { ...c, workRoot: expandHome(c.workRoot), tokei: expandHome(c.tokei), web: expandHome(c.web), db: expandHome(c.db) };
}

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
