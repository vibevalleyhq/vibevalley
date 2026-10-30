// Nowledge Mem (https://mem.nowledge.co), a knowledge graph on this Mac, spoken to over MCP: memory_search reads, memory_add writes. It is the owner's own knowledge, and the farm only adds to it. What
// the farm writes carries labels, vibevalley and the profile's, so that a profile reads back its own; with everything it
// reads all that is in it. Whatever is sent is redacted: a run's words may carry a key.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Clock, Effect, Option, Predicate, Schema } from "effect";

import { asTransport } from "@vibevalley/agent/mcpTransport";
import { t } from "@vibevalley/i18n";
import type { Memory } from "@vibevalley/protocol";

import { redact } from "@/base/redact.ts";
import type { MemorySourceConfig } from "@/setting/memorySources.ts";

import { recallWords } from "./prompts.ts";
import { memoryNotesOf, recallCount, clip, type MemoryScope } from "./recall.ts";
import { prefetchTimeoutMs, type Source, SourceError, sourceError, sourceLife } from "./sources.ts";

const app = "vibevalley";
// Its memory_search takes at most 20, and a query of at most 500 characters.
const most = 20;
const queryMost = 500;
// What a recalled line carries of one of its memories, in UTF-16 units.
const lineMost = 200;

/** The first n UTF-16 units, without cutting a character in half. */
const head = (s: string, n: number) => {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
};

/** Its labels are words without spaces or commas (the list is comma-separated). */
const label = (kind: string, name: string) => `${app}-${kind}-${name.replace(/[\s,]+/gu, "-")}`;

const projectLabel = `${app}-scope-project-`;
const globalLabel = `${app}-scope-global`;
export const nowledgeLabels = (agent: string, project: string) =>
  [app, label("agent", agent), project ? projectLabel + Buffer.from(project, "utf8").toString("hex") : globalLabel].join(",");

const scopeOf = (labels: unknown): MemoryScope => {
  if (!Array.isArray(labels) || !labels.every((l): l is string => typeof l === "string") || !labels.includes(app)) return { kind: "unknown" };
  const scopes = labels.filter((l) => l === globalLabel || l.startsWith(projectLabel));
  if (scopes.length !== 1) return { kind: "unknown" };
  const only = scopes[0]!;
  if (only === globalLabel) return { kind: "global" };
  const encoded = only.slice(projectLabel.length);
  if (!/^(?:[0-9a-f]{2})+$/u.test(encoded)) return { kind: "unknown" };
  const project = Buffer.from(encoded, "hex").toString("utf8");
  return Buffer.from(project, "utf8").toString("hex") === encoded ? { kind: "project", project } : { kind: "unknown" };
};

interface Hit {
  readonly id?: string;
  readonly memory_id?: string;
  readonly title?: string;
  readonly content?: string;
  readonly content_preview?: string;
  readonly relevance_score?: number;
}

const HitSchema: Schema.Codec<Hit> = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  memory_id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  content_preview: Schema.optionalKey(Schema.String),
  relevance_score: Schema.optionalKey(Schema.Finite),
});
const SearchResponse = Schema.fromJsonString(Schema.Struct({ results: Schema.optionalKey(Schema.mutable(Schema.Array(HitSchema))) }));
const AddedResponse = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    memory_id: Schema.optionalKey(Schema.String),
    memory: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
  }),
);
const DetailResponse = Schema.fromJsonString(Schema.Struct({ labels: Schema.optionalKey(Schema.Unknown) }));

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

  // The session opens on first use: Nowledge not running when the farm starts must not keep it off until a restart.
  // The SDK's connect is the one call; a connect that fails or is stopped closes what it opened.
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

  /** One tool call; its answer is the text of the result. A session that failed is dropped, so the next call opens another. */
  const call = (tool: string, args: Record<string, unknown>) =>
    life.alive(
      Effect.gen(function* () {
        const session = yield* Effect.tryPromise({ try: open, catch: sourceError });
        const res = yield* Effect.tryPromise({
          try: (signal) => session.callTool({ name: tool, arguments: args }, undefined, { signal }),
          catch: (e) => {
            if (!life.stopped()) {
              client = undefined;
              void session.close();
            }
            return sourceError(e);
          },
        });
        const text = (Array.isArray(res.content) ? res.content : [])
          .map((x: unknown) => (Predicate.isObject(x) && "type" in x && x.type === "text" && "text" in x && typeof x.text === "string" ? x.text : ""))
          .join("");
        if (res.isError === true) return yield* new SourceError({ message: `${tool}: ${head(text, 300)}` });
        return text;
      }),
    );

  /** agent "" reads what the farm wrote for any profile; everything reads all that is in it. */
  const find = Effect.fnUntraced(function* (agent: string, query: string, limit: number, everything: boolean) {
    const args: Record<string, unknown> = { limit: Math.max(1, Math.min(limit, most)), source_app: app };
    // Its search without a query lists nothing; filtered by labels, any query finds all they hold.
    const q = head(redact(query).trim(), queryMost) || (everything ? "" : "*");
    if (q !== "") args.query = q;
    if (!everything) args.filter_labels = agent ? label("agent", agent) : app;
    const text = yield* call("memory_search", args);
    return yield* Effect.mapBoth(Schema.decodeEffect(SearchResponse)(text), {
      onFailure: () => new SourceError({ message: "memory_search answered what it should not: " + head(text, 200) }),
      onSuccess: (r): Hit[] => r.results ?? [],
    });
  });

  const add = Effect.fnUntraced(function* (agent: string, text: string, project: string) {
    const body = redact(text);
    const answer = yield* call("memory_add", { content: body, title: head(body, 60), labels: nowledgeLabels(agent, project), source_app: app });
    // The new memory's id, at the top or under memory; none when it found the same memory there already. An answer of
    // another shape is not taken for that: the note may not have been kept, and saying so lets the source's queue log it.
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
      if (was) yield* Effect.promise(() => was.close().catch(() => {}));
    }),
    // Nothing to ask with, nothing asked: listing its newest would only be noise at the start of a run.
    prefetch: Effect.fnUntraced(function* (cue) {
      if (c.read !== true || cue.text.trim() === "") return [];
      const hits = yield* find(cue.agent, cue.text, recallCount, !(c.everything !== true));
      return hits
        .filter((h) => cue.skip?.has(hitID(h)) !== true)
        .map((h) => ({ id: hitID(h), line: recallWords.sourceLine("Nowledge", clip(hitText(h), lineMost)), score: h.relevance_score ?? 0 }));
    }),
    // Its memories are notes; it has no jobs done.
    search: Effect.fnUntraced(function* (q) {
      if (c.read !== true || q.kind === "issue") return { found: [] };
      const hits = yield* find(q.agent, q.text, q.limit, !(c.everything !== true));
      const selected = hits.slice(0, most);
      // MCP search omits labels; only its detail result can prove a project's scope. The caller's read budget covers both.
      const scopes = yield* Effect.forEach(
        selected,
        (h): Effect.Effect<MemoryScope> => {
          const id = hitID(h);
          if (!id) return Effect.succeed({ kind: "unknown" });
          return call("get_memory_by_id", { memory_id: id }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DetailResponse)),
            Effect.map((detail) => scopeOf(detail.labels)),
            // An unreadable detail does not turn an unknown project into a global memory.
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
          at: 0,
          recalled: 0,
          fading: false,
          source: "nowledge",
          score: h.relevance_score ?? 0,
          scope: scopes[index]!,
        })),
      };
    }),
    // The farm's own; Nowledge does not say which project each is for.
    list: Effect.fnUntraced(function* (agent) {
      if (c.read !== true) return [];
      const hits = yield* find(agent, "", most, false);
      return hits.map((h): Memory => ({ id: hitID(h), agent, kind: "note", text: hitText(h), at: 0, recalled: 0, fading: false }));
    }),
    // The 「记住：」 lines; a stopped run leaves nothing here either.
    syncTurn: Effect.fnUntraced(function* (run) {
      if (c.write !== true || run.outcome === "interrupted") return;
      for (const note of memoryNotesOf(run.said)) yield* add(run.agent, note.text, note.everywhere ? "" : run.project);
    }),
    sessionEnded: () => Effect.void,
    add: Effect.fnUntraced(function* (n) {
      if (c.write !== true) return undefined;
      const project = n.project.trim();
      const id = yield* add(n.agent, n.text, project);
      const at = yield* Clock.currentTimeMillis;
      return { id, agent: n.agent, kind: "note", text: n.text, at, recalled: 0, fading: false, ...(project ? { project } : {}) } satisfies Memory;
    }),
    forget: () => Effect.fail(new SourceError({ message: t("server.memory.nowledgeForget") })),
    can: { list: true, forget: false, transcripts: false },
  };
}
