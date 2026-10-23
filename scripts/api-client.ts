// Writes packages/protocol/src/client.ts, the HTTP client (VibeValleyApi), from packages/protocol/src/api.ts: each
// method's arguments, answer and doc comment from the Handlers interface, its method, path, query and body from
// `endpoints`. Generated rather than read from `endpoints` at run time: the page would then load effect's Schema for every
// endpoint. --check fails when the file is not what api.ts says (docs:verify runs it).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endpoints } from "../packages/protocol/src/api.ts";

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
    if (!member.endsWith(";")) continue;
    const m = /^readonly "([\w.]+)": \((.*)\) => Effect\.Effect<(.+), ApiError, R>;$/.exec(member);
    if (!m) throw new Error(`api-client: cannot read the Handlers member: ${member}`);
    found.set(m[1]!, { args: m[2]!, result: m[3]!, doc });
    member = "";
    doc = "";
  }
  return found;
}

const signatures = handlers(readFileSync(join(protocol, "api.ts"), "utf8"));

function method(e: (typeof endpoints)[number]): string {
  const sig = signatures.get(e.op);
  if (!sig) throw new Error(`api-client: ${e.op} is in endpoints but not in Handlers`);
  const name = e.op.split(".")[1]!;
  // "/api/v1/issues/{id}/runs" → "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/runs"
  const path = e.path
    .split(/(\{\w+\})/)
    .filter((p) => p !== "")
    .map((p) => (p.startsWith("{") ? `encodeURIComponent(String(a.${p.slice(1, -1)}))` : JSON.stringify(p)))
    .join(" + ");
  const query = e.query.length === 0 ? "undefined" : `{ ${e.query.map((q) => `${q.name}: a.${q.name}`).join(", ")} }`;
  const body = e.body === undefined ? "undefined" : "a.body";
  const args = sig.args.replaceAll("readonly ", "");
  const doc = sig.doc
    ? sig.doc
        .split("\n")
        .map((l, i) => (i === 0 ? l : " " + l))
        .join("\n    ") + "\n    "
    : "";
  const result = sig.result;
  return `    ${doc}${name}: (${args}): Promise<${result}> => this.call(${JSON.stringify(e.method)}, ${path}, ${query}, ${body}) as Promise<${result}>,`;
}

const groups = new Map<string, string[]>();
for (const e of endpoints) {
  const g = e.op.split(".")[0]!;
  groups.set(g, [...(groups.get(g) ?? []), method(e)]);
}
for (const op of signatures.keys()) if (!endpoints.some((e) => e.op === op)) throw new Error(`api-client: ${op} is in Handlers but not in endpoints`);

const text = `// Written by scripts/api-client.ts from api.ts (Handlers and endpoints); do not edit: pnpm run api:client.

import type { ApiError } from "./api";
import type * as T from "./shapes";

/** A refusal from the server: its tagged error (Refused, VoiceUnavailable…) and reason, or the bare status. */
export class VibeValleyApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    readonly reason: string,
    /** The error as the server wrote it, for what it carries besides the reason. */
    readonly error?: ApiError,
  ) {
    super(reason);
  }
}

/** The server's HTTP API, one object per group: \`api.issue.create({ body })\`. */
export class VibeValleyApi {
  /** base: the server's address; empty is the page's own origin, which serves it. */
  constructor(
    readonly base = "",
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}
${[...groups].map(([g, ms]) => `\n  readonly ${g} = {\n${ms.join("\n")}\n  };\n`).join("")}
  private async call(method: string, path: string, query: Record<string, string | number | boolean | undefined> | undefined, body: unknown): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
    const url = this.base + path + (params.size > 0 ? "?" + params.toString() : "");
    const res = await this.fetcher(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const decoded: unknown = text === "" ? undefined : JSON.parse(text);
    if (!res.ok) {
      const j = (decoded ?? {}) as { _tag?: unknown; reason?: unknown; what?: unknown };
      // Missing says what is not there; every other ApiError gives its reason.
      const reason = typeof j.reason === "string" ? j.reason : typeof j.what === "string" ? j.what : "服务端答 " + res.status;
      throw new VibeValleyApiError(
        res.status,
        typeof j._tag === "string" ? j._tag : undefined,
        reason,
        typeof j._tag === "string" ? (j as ApiError) : undefined,
      );
    }
    return decoded;
  }
}
`;

const format = (t: string) => {
  // The same formatter as bun run check, so the file it writes is the file check:fix would leave.
  const done = spawnSync("pnpm", ["exec", "vp", "fmt", `--stdin-filepath=${out}`], { input: t, encoding: "utf8", cwd: join(import.meta.dirname, "..") });
  return done.status === 0 ? done.stdout : t;
};

const formatted = format(text);
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== formatted) {
    console.error("api-client: packages/protocol/src/client.ts is stale: run pnpm run api:client");
    process.exit(1);
  }
} else writeFileSync(out, formatted);
