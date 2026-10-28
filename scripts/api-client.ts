// Writes packages/protocol/src/client.ts, the HTTP client (VibeValleyApi), from packages/protocol/src/api.ts: each
// method's arguments, answer and doc comment from the Handlers interface, its method, path, query and body from
// `endpoints`. Generated rather than read from `endpoints` at run time: the page would then load effect's Schema for every
// endpoint. --check fails when the file is not what api.ts says (docs:verify runs it).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endpoints, pathOf } from "../packages/protocol/src/api.ts";

const protocol = join(import.meta.dirname, "..", "packages/protocol/src");
const out = join(protocol, "client.ts");

/** Handlers' members as written: "group.name" → its argument list, its answer type and its doc comment. */
function handlers(source: string) {
  const start = source.indexOf("export interface Handlers<R = never> {");
  const body = source.slice(source.indexOf("\n", start) + 1, source.indexOf("\n}\n", start));
  const found = new Map<string, { args: string; result: string; doc: string }>();
  let doc = "";
  let inDoc = false;
  let member = "";
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (member === "" && (inDoc || t.startsWith("/**"))) {
      doc += (doc ? "\n" : "") + t;
      inDoc = !t.endsWith("*/");
      continue;
    }
    member += (member ? " " : "") + t;
    if (!member.endsWith("ApiError, R>;")) continue;
    const m = /^readonly "([\w.]+)": \((.*)\) => Effect\.Effect<(.+), ApiError, R>;$/.exec(member);
    if (!m) throw new Error(`api-client: cannot read the Handlers member: ${member}`);
    found.set(m[1]!, { args: m[2]!, result: m[3]!, doc });
    member = "";
    doc = "";
  }
  return found;
}

const signatures = handlers(readFileSync(join(protocol, "api.ts"), "utf8"));

function method(e: (typeof endpoints)[number], indent: string): string {
  const sig = signatures.get(e.op);
  if (!sig) throw new Error(`api-client: ${e.op} is in endpoints but not in Handlers`);
  const name = e.op.split(".").at(-1)!;
  const args = sig.args.replaceAll("readonly ", "");
  const doc = sig.doc
    ? sig.doc
        .split("\n")
        .map((l, i) => (i === 0 ? l : " " + l))
        .join("\n" + indent) +
      "\n" +
      indent
    : "";
  const input = e.input === undefined ? "undefined" : "a";
  return `${indent}${doc}${name}: (${args}): Promise<${sig.result}> => this.call(${JSON.stringify(pathOf(e.op))}, ${input}) as Promise<${sig.result}>,`;
}

// module → its own ops and its nouns' (issue.create, issue.status.update).
const groups = new Map<string, { own: string[]; nouns: Map<string, string[]> }>();
for (const e of endpoints) {
  const [g, ...rest] = e.op.split(".");
  const group = groups.get(g!) ?? { own: [], nouns: new Map<string, string[]>() };
  groups.set(g!, group);
  if (rest.length === 1) group.own.push(method(e, "    "));
  else group.nouns.set(rest[0]!, [...(group.nouns.get(rest[0]!) ?? []), method(e, "      ")]);
}
for (const op of signatures.keys()) if (!endpoints.some((e) => e.op === op)) throw new Error(`api-client: ${op} is in Handlers but not in endpoints`);

const groupText = ([g, { own, nouns }]: [string, { own: string[]; nouns: Map<string, string[]> }]) =>
  `\n  readonly ${g} = {\n${[...own, ...[...nouns].map(([n, ms]) => `    ${n}: {\n${ms.join("\n")}\n    },`)].join("\n")}\n  };\n`;

const text = `// Written by scripts/api-client.ts from api.ts (Handlers and endpoints); do not edit: vp run api:client.

import type { ApiError } from "./api";
import type * as T from "./shapes";
import { t } from "@vibevalley/i18n";

/** A refusal from the server: its tagged error (Refused, VoiceUnavailable…) and reason, or the bare status. */
export class VibeValleyApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    readonly reason: string,
    /** The error as the server wrote it, for what it carries besides the reason. */
    readonly error?: ApiError,
    /** The response exactly as received, including plain text that was not JSON. */
    readonly body?: string,
  ) {
    super(reason);
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const validNext = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => record(item) && typeof item.say === "string" && (item.run === undefined || strings(item.run))));
const validReason = (value: unknown): boolean => record(value) && typeof value.reason === "string";

// Kept dependency-free: the page does not load the endpoint Schemas just to read an error.
function apiErrorOf(value: unknown): ApiError | undefined {
  if (!record(value) || typeof value._tag !== "string") return undefined;
  switch (value._tag) {
    case "Refused":
    case "ConnectorRefused":
    case "LanRefused":
      return validReason(value) && validNext(value.next) ? (value as unknown as ApiError) : undefined;
    case "Missing":
      return typeof value.what === "string" && validNext(value.next) ? (value as unknown as ApiError) : undefined;
    case "VoiceUnavailable":
      return validReason(value) && (value.settings === undefined || ["deepseek", "voice"].includes(value.settings as string))
        ? (value as unknown as ApiError)
        : undefined;
    case "VoiceAgentFailed":
      return validReason(value) ? (value as unknown as ApiError) : undefined;
    default:
      return undefined;
  }
}

/** The server's HTTP API, one object per module and noun, a method per op: \`api.issue.status.update({ id, status })\`. */
export class VibeValleyApi {
  /** base: the server's address; empty is the page's own origin, which serves it. */
  constructor(
    readonly base = "",
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}
${[...groups].map(groupText).join("")}
  private async call(path: string, input: unknown): Promise<unknown> {
    const res = await this.fetcher(this.base + path, {
      method: "POST",
      headers: input === undefined ? undefined : { "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const text = await res.text();
    if (!res.ok) {
      let decoded: unknown;
      try {
        decoded = text === "" ? undefined : JSON.parse(text);
      } catch {
        decoded = undefined;
      }
      const error = apiErrorOf(decoded);
      const j = record(decoded) ? decoded : {};
      const reason = error
        ? error._tag === "Missing"
          ? error.what
          : error.reason
        : typeof j.reason === "string"
          ? j.reason
          : typeof j.what === "string"
            ? j.what
            : text.trim() || t("shared.serverAnswered", { status: res.status });
      throw new VibeValleyApiError(res.status, typeof j._tag === "string" ? j._tag : undefined, reason, error, text);
    }
    return text === "" ? undefined : JSON.parse(text);
  }
}
`;

const format = (t: string) => {
  // The same formatter as vp check, so the file it writes is the file vp check --fix would leave.
  const done = spawnSync("vp", ["fmt", `--stdin-filepath=${out}`], { input: t, encoding: "utf8", cwd: join(import.meta.dirname, "..") });
  return done.status === 0 ? done.stdout : t;
};

const formatted = format(text);
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== formatted) {
    console.error("api-client: packages/protocol/src/client.ts is stale: run vp run api:client");
    process.exit(1);
  }
} else writeFileSync(out, formatted);
