import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { endpoints, pathOf } from "@vibevalley/protocol/api";

const protocol = join(import.meta.dirname, "../..", "packages/protocol/src");
const out = join(protocol, "client.ts");

/** A concept's Handlers members as written: "group.name" → its argument list, its answer type and its doc comment. */
function handlers(source: string, found: Map<string, { args: string; result: string; doc: string }>) {
  const start = source.search(/export interface \w+Handlers \{/u);
  if (start < 0) return found;
  const body = source.slice(source.indexOf("\n", start) + 1, source.indexOf("\n}\n", start));
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
    if (!member.endsWith(">;")) continue;
    const m = /^readonly "([\w.]+)": \((.*)\) => Promise<(.+)>;$/u.exec(member);
    if (!m) throw new Error(`api-client: cannot read the Handlers member: ${member}`);
    found.set(m[1]!, { args: m[2]!, result: m[3]!, doc });
    member = "";
    doc = "";
  }
  return found;
}

const signatures = new Map<string, { args: string; result: string; doc: string }>();
for (const concept of readdirSync(protocol).toSorted()) {
  const file = join(protocol, concept, "api.ts");
  if (statSync(join(protocol, concept)).isDirectory() && readdirSync(join(protocol, concept)).includes("api.ts"))
    handlers(readFileSync(file, "utf8"), signatures);
}

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
  return `${indent}${doc}${name}: (${args ? args + ", " : ""}options?: { signal?: AbortSignal }): Promise<${sig.result}> => this.call<${sig.result}>(${JSON.stringify(pathOf(e.op))}, ${input}, options),`;
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

import type { z } from "zod";

import { t } from "@vibevalley/i18n";

import {
  type ApiErrorDetail,
  ApiErrorEnvelope,
  type ApiErrorKind,
  apiSuccessEnvelope,
  ApiVoidEnvelope,
  bizCodeMeta,
  type BizErrorCode,
  endpoints,
  pathOf,
} from "./api";
import type * as T from "./shapes";

/** A refusal from the server: its business code, semantic kind (Refused, VoiceUnavailable…), reason, and optional remediation detail. */
export class VibeValleyApiError extends Error {
  readonly status: number;
  readonly bizCode: BizErrorCode | undefined;
  readonly tag: ApiErrorKind | undefined;
  readonly reason: string;
  /** Structured remediation detail inside the envelope's error field (next steps, settings section). */
  readonly error: ApiErrorDetail | undefined;
  /** The response exactly as received, including plain text that was not JSON. */
  readonly body: string | undefined;

  constructor(status: number, tag: ApiErrorKind | undefined, reason: string, error?: ApiErrorDetail, body?: string, bizCode?: BizErrorCode) {
    super(reason);
    this.status = status;
    this.bizCode = bizCode;
    this.tag = tag;
    this.reason = reason;
    this.error = error;
    this.body = body;
  }
}

const decodeApiError = (u: unknown) => {
  const r = ApiErrorEnvelope.safeParse(u);
  return r.success ? r.data : undefined;
};
const resultDecoders = new Map<string, { readonly hasData: boolean; readonly envelope: z.ZodType }>();
for (const e of endpoints) {
  resultDecoders.set(pathOf(e.op), { hasData: e.result !== undefined, envelope: e.result ? apiSuccessEnvelope(e.result) : ApiVoidEnvelope });
}

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null;

/** The server's HTTP API, one object per module and noun, a method per op: \`api.issue.status.update({ id, status })\`. */
export class VibeValleyApi {
  /** The server's address; empty is the page's own origin, which serves it. */
  readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  /** A device key to send as a Bearer token: the command line's, signed in to a server through its gate. */
  private readonly key: string | undefined;

  constructor(base = "", fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init), key?: string) {
    this.base = base;
    this.fetcher = fetcher;
    this.key = key;
  }
${[...groups].map(groupText).join("")}
  /** R is the answer api.ts gives the path; each method above names it. */
  private async call<R>(path: string, input: unknown, options?: { signal?: AbortSignal }): Promise<R> {
    const headers: Record<string, string> = this.key === undefined ? {} : { authorization: "Bearer " + this.key };
    const res = await this.fetcher(this.base + path, {
      ...(input === undefined
        ? { method: "POST", headers }
        : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(input) }),
      ...options,
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const env = decodeApiError(parsed);
      if (env) {
        const meta = bizCodeMeta[env.bizCode];
        throw new VibeValleyApiError(res.status, meta.kind, env.message, env.error, text, env.bizCode);
      }
      const j = isObject(parsed) ? parsed : {};
      const reason = typeof j.message === "string" && j.message !== "" ? j.message : text.trim() || t("shared.serverAnswered", { status: res.status });
      throw new VibeValleyApiError(res.status, undefined, reason, undefined, text);
    }
    const raw: unknown = text === "" ? undefined : JSON.parse(text);
    const entry = resultDecoders.get(path);
    const checked = entry ? entry.envelope.safeParse(raw) : undefined;
    if (checked && !checked.success) {
      const env = decodeApiError(raw);
      if (env) {
        const meta = bizCodeMeta[env.bizCode];
        throw new VibeValleyApiError(meta.status, meta.kind, env.message, env.error, text, env.bizCode);
      }
      throw new Error(\`\${path}: a response not in its shape: \${checked.error.message}\`);
    }
    const value = checked && entry?.hasData === true && isObject(checked.data) ? checked.data.data : undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above with the endpoint's own result Schema from api.ts
    return value as R;
  }
}
`;

const format = (t: string) => {
  // The same formatter as vp check, so the file it writes is the file vp check --fix would leave.
  const done = spawnSync("vp", ["fmt", `--stdin-filepath=${out}`], { input: t, encoding: "utf8", cwd: join(import.meta.dirname, "../..") });
  return done.status === 0 ? done.stdout : t;
};

const formatted = format(text);
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== formatted) {
    console.error("api-client: packages/protocol/src/client.ts is stale: run vp run api:client");
    process.exit(1);
  }
} else writeFileSync(out, formatted);
