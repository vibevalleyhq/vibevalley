import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Nowledge Mem (https://mem.nowledge.co), a knowledge graph on this Mac, spoken to over MCP: memory_search reads, memory_add writes.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Clock, Effect, Option, Schema } from "effect";

import { asTransport } from "@vibevalley/agent/mcpTransport";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { head, clip } from "#/base/clip.ts";
import { redact, type RedactedString, redactedHead } from "#/base/redact.ts";
import type { MemorySourceConfig } from "#/setting/memorySources.ts";

import { recallWords } from "./prompts.ts";
import { recallCount, type MemoryScope } from "./recall.ts";
import { prefetchTimeoutMs, type Source, SourceError, sourceError, sourceLife } from "./sources.ts";

const app = "vibevalley";
// Its memory_search takes at most 20, and a query of at most 500 characters.
const most = 20;
const queryMost = 500;
// What a recalled line carries of one of its memories, in UTF-16 units.
const lineMost = 200;

/** What goes to Nowledge: every free text in it redacted. */
type Search = { readonly limit: number; readonly source_app: string; readonly query?: RedactedString | ""; readonly filter_labels?: string };
type Add = { readonly content: RedactedString; readonly title: RedactedString; readonly labels: string; readonly source_app: string };
type Detail = { readonly memory_id: string };

/** Its labels are words without spaces or commas (the list is comma-separated). */
const label = (kind: string, name: string) => `${app}-${kind}-${name.replace(/[\s,]+/gu, "-")}`;

const repoLabel = `${app}-scope-repo-`;
const globalLabel = `${app}-scope-global`;
export const nowledgeLabels = (agent: string, repo: string) =>
  [app, label("agent", agent), repo ? repoLabel + Buffer.from(repo, "utf8").toString("hex") : globalLabel].join(",");

const scopeOf = (labels: readonly string[] | undefined): MemoryScope => {
  if (!labels || !labels.includes(app)) return { kind: "unknown" };
  const [only, ...extra] = labels.filter((l) => l === globalLabel || l.startsWith(repoLabel));
  if (!only || extra.length > 0) return { kind: "unknown" };
  if (only === globalLabel) return { kind: "global" };
  const encoded = only.slice(repoLabel.length);
  if (!/^(?:[0-9a-f]{2})+$/u.test(encoded)) return { kind: "unknown" };
  const repo = Buffer.from(encoded, "hex").toString("utf8");
  return Buffer.from(repo, "utf8").toString("hex") === encoded ? { kind: "repo", repo } : { kind: "unknown" };
};

const HitSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  memory_id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  content_preview: Schema.optionalKey(Schema.String),
  relevance_score: Schema.optionalKey(Schema.Finite),
});
type Hit = typeof HitSchema.Type;
const SearchResponse = Schema.fromJsonString(Schema.Struct({ results: Schema.optionalKey(Schema.mutable(Schema.Array(HitSchema))) }));
const AddedResponse = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    memory_id: Schema.optionalKey(Schema.String),
    memory: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
  }),
);
const DetailResponse = Schema.fromJsonString(Schema.Struct({ labels: Schema.optionalKey(Schema.Array(Schema.String)) }));
const ToolAnswer = Schema.Struct({
  content: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        text: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});

const hitID = (h: Hit) => h.memory_id || h.id || "";

function hitText(h: Hit): string {
  const body = h.content_preview || h.content || "";
  return !h.title || body.startsWith(h.title) ? body : recallWords.titled(h.title, body);
}

export function nowledge(c: MemorySourceConfig): Source {
  const life = sourceLife("Nowledge");
  // The session is the SDK's, shared by every call: connecting it is not any one call's to cancel, only stop's.
  const connecting = new AbortController();
  let client: Promise<Client> | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  // The session opens on first use: Nowledge not running when the farm starts must not keep it off until a restart. The SDK's connect is the one call.
  const connect = () => {
    const wire = new StreamableHTTPClientTransport(new URL(c.url), c.key ? { requestInit: { headers: { Authorization: `Bearer ${c.key}` } } } : {});
    transport = wire;
    const one = new Client({ name: app, version: "1" });
    return one
      .connect(asTransport(wire), { timeout: prefetchTimeoutMs, signal: connecting.signal })
      .then(() => connecting.signal.throwIfAborted())
      .then(
        () => one,
        (e: unknown) =>
          Promise.allSettled([one.close(), wire.close()]).then(() => {
            throw e;
          }),
      );
  };
  const open = () =>
    (client ??= connect().catch((e: unknown) => {
      client = undefined;
      throw e;
    }));

  /** One tool call. its answer is the text of the result. */
  const call = (tool: "memory_search" | "memory_add" | "get_memory_by_id", args: Search | Add | Detail) =>
    life.alive(
      Effect.gen(function* () {
        const pending = open();
        const session = yield* Effect.tryPromise({ try: () => pending, catch: sourceError });
        const res = yield* Effect.tryPromise({
          try: (signal) => session.callTool({ name: tool, arguments: args }, undefined, { signal }),
          catch: (e) => {
            if (!life.stopped()) {
              if (client === pending) client = undefined;
              void session.close();
            }
            return sourceError(e);
          },
        });
        const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ToolAnswer)(res));
        const text = (parsed?.content ?? []).map((x) => (x.type === "text" ? (x.text ?? "") : "")).join("");
        if (parsed?.isError === true) return yield* new SourceError({ message: `${tool}: ${head(text, 300)}` });
        return text;
      }),
    );

  /** agent "" reads what the farm wrote for any profile; everything reads all that is in it. */
  const find = Effect.fnUntraced(function* (agent: string, query: string, limit: number, everything: boolean) {
    // Its search without a query lists nothing; filtered by labels, any query finds all they hold.
    const asked = redactedHead(redact(query), queryMost);
    const q = asked !== "" ? asked : everything ? "" : redact("*");
    const args: Search = {
      limit: Math.max(1, Math.min(limit, most)),
      source_app: app,
      ...(q !== "" ? { query: q } : {}),
      ...(everything ? {} : { filter_labels: agent ? label("agent", agent) : app }),
    };
    const text = yield* call("memory_search", args);
    return yield* Effect.mapBoth(Schema.decodeEffect(SearchResponse)(text), {
      onFailure: () => new SourceError({ message: "memory_search answered what it should not: " + head(text, 200) }),
      onSuccess: (r): Hit[] => r.results ?? [],
    });
  });

  const add = Effect.fnUntraced(function* (agent: string, text: string, repo: string) {
    const body = redact(text);
    const answer = yield* call("memory_add", { content: body, title: redactedHead(body, 60), labels: nowledgeLabels(agent, repo), source_app: app });
    // The new memory's id, at the top or under memory. none when it found the same memory there already.
    const added = Option.getOrUndefined(Schema.decodeOption(AddedResponse)(answer));
    if (!added) return yield* new SourceError({ message: "memory_add answered what it should not: " + head(answer, 200) });
    return added.memory_id || added.id || added.memory?.id || "";
  });

  return {
    name: "nowledge",
    unavailable: () => (c.url ? undefined : t("server.memory.noUrl")),
    // Closing the transport ends a connect still waiting on a Nowledge that does not answer.
    stop: Effect.gen(function* () {
      if (!(yield* life.stop)) return;
      connecting.abort(new Error("Nowledge source has stopped"));
      const was = transport;
      client = undefined;
      transport = undefined;
      if (was) yield* Effect.tryPromise({ try: () => was.close(), catch: sourceError }).pipe(Effect.ignore({ log: "Debug" }));
    }),
    // Nothing to ask with, nothing asked: listing its newest would only be noise at the start of a run.
    prefetch: Effect.fnUntraced(function* (cue) {
      if (c.read !== true || cue.text.trim() === "") return [];
      const hits = yield* find(cue.agent, cue.text, recallCount, !(c.everything !== true));
      return hits
        .filter((h) => cue.skip?.has(hitID(h)) !== true)
        .map((h) => ({ id: hitID(h), line: recallWords.sourceLine("Nowledge", clip(hitText(h), lineMost)), score: h.relevance_score ?? 0 }));
    }),
    // Its memories are notes; it has no issues worked.
    search: Effect.fnUntraced(function* (q) {
      if (c.read !== true || q.kind === "issue") return { found: [] };
      const hits = yield* find(q.agent, q.text, q.limit, !(c.everything !== true));
      const selected = hits.slice(0, most);
      // MCP search omits labels. only its detail result can prove a repo's scope.
      const scopes = yield* Effect.forEach(
        selected,
        (h): Effect.Effect<MemoryScope> => {
          const id = hitID(h);
          if (!id) return Effect.succeed({ kind: "unknown" });
          return call("get_memory_by_id", { memory_id: id }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DetailResponse)),
            Effect.map((detail) => scopeOf(detail.labels)),
            // An unreadable detail does not turn an unknown repo into a global memory.
            Effect.orElseSucceed((): MemoryScope => ({ kind: "unknown" })),
          );
        },
        { concurrency: 2 },
      );
      return {
        found: selected.map((h, index) => ({
          id: hitID(h),
          agent: q.agent,
          kind: "note" as const,
          text: hitText(h),
          author: "system" as const,
          at: 0,
          recalled: 0,
          fading: false,
          source: "nowledge",
          score: h.relevance_score ?? 0,
          scope: scopes[index] ?? { kind: "unknown" },
        })),
      };
    }),
    // The farm's own; Nowledge does not say which repo each is for.
    list: Effect.fnUntraced(function* (agent) {
      if (c.read !== true) return [];
      const hits = yield* find(agent, "", most, false);
      return hits.map((h): T.Memory => ({ id: hitID(h), agent, kind: "note", text: hitText(h), author: "system", at: 0, recalled: 0, fading: false }));
    }),
    syncTurn: () => Effect.void,
    sessionEnded: () => Effect.void,
    add: Effect.fnUntraced(function* (n) {
      if (c.write !== true) return undefined;
      const repo = n.repo.trim();
      const id = yield* add(n.agent, n.text, repo);
      const at = yield* Clock.currentTimeMillis;
      return { id, agent: n.agent, kind: "note", text: n.text, author: "system", at, recalled: 0, fading: false, ...(repo ? { repo } : {}) } satisfies T.Memory;
    }),
    forget: () => Effect.fail(new SourceError({ message: t("server.memory.nowledgeForget") })),
    can: { list: true, forget: false, transcripts: false },
  };
}
