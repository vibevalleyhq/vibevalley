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
    const m = /^readonly "([\w.]+)": \((.*)\) => Effect\.Effect<(.+), ApiError, R>;$/u.exec(member);
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
  return `${indent}${doc}${name}: (${args}): Promise<${sig.result}> => this.call<${sig.result}>(${JSON.stringify(pathOf(e.op))}, ${input}),`;
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

import { Predicate } from "effect";

import type { ApiError } from "./api";
import { VoiceFixValues } from "./shapes";
import type * as T from "./shapes";
import { t } from "@vibevalley/i18n";

/** A refusal from the server: its tagged error (Refused, VoiceUnavailable…) and reason, or the bare status. */
// The client is Promise-based and its callers (the page, the shells) reject and catch plain Errors, not Effect failures.
// @effect-diagnostics-next-line extendsNativeError:off
export class VibeValleyApiError extends Error {
  readonly status: number;
  readonly tag: string | undefined;
  readonly reason: string;
  /** The error as the server wrote it, for what it carries besides the reason. */
  readonly error: ApiError | undefined;
  /** The response exactly as received, including plain text that was not JSON. */
  readonly body: string | undefined;

  constructor(status: number, tag: string | undefined, reason: string, error?: ApiError, body?: string) {
    super(reason);
    this.status = status;
    this.tag = tag;
    this.reason = reason;
    this.error = error;
    this.body = body;
  }
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const validNext = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => Predicate.isObject(item) && typeof item.say === "string" && (item.run === undefined || strings(item.run))));
const validReason = (value: unknown): boolean => Predicate.isObject(value) && typeof value.reason === "string";

// Kept free of Schema: the page does not load the endpoint Schemas just to read an error.
function apiErrorOf(value: unknown): ApiError | undefined {
  if (!Predicate.isObject(value) || typeof value._tag !== "string") return undefined;
  let valid: boolean;
  switch (value._tag) {
    case "Refused":
    case "ConnectorRefused":
    case "LanRefused":
      valid = validReason(value) && validNext(value.next);
      break;
    case "Missing":
      valid = typeof value.what === "string" && validNext(value.next);
      break;
    case "VoiceUnavailable":
      valid = validReason(value) && (value.settings === undefined || VoiceFixValues.some((fix) => fix === value.settings));
      break;
    case "VoiceCallFailed":
      valid = validReason(value);
      break;
    default:
      valid = false;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every field the page reads is checked above; it reads them, not the class's methods
  return valid ? (value as unknown as ApiError) : undefined;
}

/** The server's HTTP API, one object per module and noun, a method per op: \`api.issue.status.update({ id, status })\`. */
export class VibeValleyApi {
  /** The server's address; empty is the page's own origin, which serves it. */
  readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;

  constructor(base = "", fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {
    this.base = base;
    this.fetcher = fetcher;
  }
${[...groups].map(groupText).join("")}
  /** R is the answer api.ts gives the path; each method above names it. */
  private async call<R>(path: string, input: unknown): Promise<R> {
    const res = await this.fetcher(
      this.base + path,
      input === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    );
    const text = await res.text();
    if (!res.ok) {
      let decoded: unknown;
      try {
        decoded = text === "" ? undefined : JSON.parse(text);
      } catch {
        decoded = undefined;
      }
      const error = apiErrorOf(decoded);
      const j = Predicate.isObject(decoded) ? decoded : {};
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the server answers each path with what api.ts says (its handlers are typed by the same Handlers); the page trusts its own server rather than load every Schema
    return (text === "" ? undefined : JSON.parse(text)) as R;
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
