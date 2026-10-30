// EverOS (github.com/EverMind-AI/EverOS) over its HTTP API, /api/v2. It is given whole
// runs and extracts memories itself with a model: memory/add takes a session's messages, memory/flush makes it extract
// them (here when the session leaves the farm), memory/search reads back. What a helper says is the agent's (agent_id,
// read back as agent_cases), what it was asked is the owner's (user_id, read back as episodes). Every message is redacted
// first: a helper's words may carry a key.

import { createHash } from "node:crypto";

import { Clock, Effect, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";

import { t } from "@vibevalley/i18n";
import type { MemoryKind } from "@vibevalley/protocol";

import { newId } from "@/base/ids.ts";
import { redact } from "@/base/redact.ts";
import type { MemorySourceConfig } from "@/setting/memorySources.ts";

import { everosWords, recallWords } from "./prompts.ts";
import { clip, recallCount, type MemoryScope } from "./recall.ts";
import { prefetchTimeoutMs, type Source, SourceError, sourceError, sourceLife } from "./sources.ts";

/** app_id on everything written, so its memories can be told from another app's. */
const app = "vibevalley";
const most = 100;
const lineMost = 200;

interface Message {
  readonly sender_id: string;
  readonly role: "user" | "assistant";
  readonly timestamp: number;
  content: string;
}

interface FoundBody {
  readonly data?: {
    readonly episodes?: readonly { id: string; subject?: string; summary?: string; episode?: string; score?: number; app_id?: string; project_id?: string }[];
    readonly agent_cases?: readonly {
      id: string;
      task_intent?: string;
      approach?: string;
      key_insight?: string;
      score?: number;
      app_id?: string;
      project_id?: string;
    }[];
  };
}

const Episode = Schema.Struct({
  id: Schema.String,
  subject: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  episode: Schema.optionalKey(Schema.String),
  score: Schema.optionalKey(Schema.Finite),
  app_id: Schema.optionalKey(Schema.String),
  project_id: Schema.optionalKey(Schema.String),
});
const AgentCase = Schema.Struct({
  id: Schema.String,
  task_intent: Schema.optionalKey(Schema.String),
  approach: Schema.optionalKey(Schema.String),
  key_insight: Schema.optionalKey(Schema.String),
  score: Schema.optionalKey(Schema.Finite),
  app_id: Schema.optionalKey(Schema.String),
  project_id: Schema.optionalKey(Schema.String),
});
const FoundPayload: Schema.Codec<FoundBody> = Schema.Struct({
  data: Schema.optionalKey(Schema.Struct({ episodes: Schema.optionalKey(Schema.Array(Episode)), agent_cases: Schema.optionalKey(Schema.Array(AgentCase)) })),
});
const FoundBodySchema = Schema.fromJsonString(FoundPayload);

// EverOS scope ids are ASCII and at most 128 characters; a real project named "global" must stay separate from global notes.
const scopeOf = (project: string) => (project ? "project-" + createHash("sha256").update(project).digest("hex") : "global");

/** A farm's session ids (w1, w2…) are its own only: another farm on the same EverOS has a w1 too. */
const sessionOf = (session: string) => `${app}-${session}`;
const agentOf = (agent: string) => `${app}-${agent}`;

/** http: the farm's client; interrupting a call aborts its request. */
export function everos(c: MemorySourceConfig, http: HttpClient.HttpClient): Source {
  const life = sourceLife("EverOS");
  const user = c.user || "owner";
  /** Sessions given messages and not yet told to extract; flushed when the session ends, or when the farm stops. */
  const pending = new Map<string, string>();
  /** Sessions whose job it was given already: a later run sends only what the helper said. */
  const told = new Set<string>();

  /** The answer's text; closing: the flush as it stops, which its stop does not cut short. */
  const post = (path: string, body: unknown, closing = false) => {
    const request = HttpClientRequest.post(`${c.url.replace(/\/+$/u, "")}/api/v2/memory/${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      c.key ? HttpClientRequest.bearerToken(c.key) : (r) => r,
    );
    const answer = Effect.gen(function* () {
      const res = yield* http.execute(request);
      const text = (yield* res.text).slice(0, 4 << 20);
      if (res.status < 200 || res.status >= 300) return yield* new SourceError({ message: `memory/${path}: ${res.status} ${text.slice(0, 300)}` });
      return text;
    }).pipe(Effect.catchTag("HttpClientError", (e) => Effect.fail(sourceError(e))));
    return closing ? answer : life.alive(answer);
  };

  const add = Effect.fnUntraced(function* (session: string, project: string, messages: Message[]) {
    for (const m of messages) m.content = redact(m.content);
    yield* post("add", { session_id: session, messages, app_id: app, project_id: scopeOf(project) });
    pending.set(session, project);
  });

  const flush = (session: string, project: string, closing = false) =>
    post("flush", { session_id: session, app_id: app, project_id: scopeOf(project) }, closing);

  /** A profile's cases, or with kind issue the owner's episodes. */
  const findIn = Effect.fnUntraced(function* (agent: string, query: string, limit: number, kind: MemoryKind, project: string) {
    const scope = scopeOf(project);
    const body = {
      app_id: app,
      project_id: scope,
      query: redact(query).trim().slice(0, 1000),
      top_k: Math.max(1, Math.min(limit, most)),
      ...(kind === "issue" ? { user_id: user } : { agent_id: agentOf(agent) }),
    };
    const text = yield* post("search", body);
    const found = yield* Effect.mapError(
      Schema.decodeEffect(FoundBodySchema)(text),
      () => new SourceError({ message: "memory/search answered what it should not: " + text.slice(0, 200) }),
    );
    const ownership = (hit: { app_id?: string; project_id?: string }): MemoryScope =>
      hit.app_id !== app || hit.project_id !== scope ? { kind: "unknown" } : project ? { kind: "project", project } : { kind: "global" };
    const hits: { id: string; text: string; score: number; scope: MemoryScope }[] = [];
    for (const k of found.data?.agent_cases ?? [])
      hits.push({
        id: `${scope}:${k.id}`,
        text: recallWords.parts([k.task_intent, k.approach, k.key_insight].map((p) => (p ?? "").trim()).filter((p) => p !== "")),
        score: k.score ?? 0,
        scope: ownership(k),
      });
    for (const ep of found.data?.episodes ?? []) {
      const item = ep.summary || ep.episode || "";
      hits.push({ id: `${scope}:${ep.id}`, text: ep.subject ? recallWords.titled(ep.subject, item) : item, score: ep.score ?? 0, scope: ownership(ep) });
    }
    return hits;
  });

  const find = (agent: string, query: string, limit: number, kind: MemoryKind, project: string) =>
    Effect.map(
      Effect.forEach(project ? [project, ""] : [""], (p) => findIn(agent, query, limit, kind, p), { concurrency: "unbounded" }),
      (all) => all.flat().toSorted((a, b) => b.score - a.score),
    );

  return {
    name: "everos",
    unavailable: () => (c.url ? undefined : t("server.memory.noUrl")),
    // What it was given and not told to extract yet is extracted now: EverOS only extracts on a flush.
    stop: Effect.gen(function* () {
      if (!(yield* life.stop)) return;
      const all = [...pending];
      pending.clear();
      told.clear();
      yield* Effect.forEach(all, ([session, project]) => Effect.ignore(flush(session, project, true)), { concurrency: "unbounded", discard: true }).pipe(
        Effect.timeoutOption(prefetchTimeoutMs),
      );
    }),
    prefetch: Effect.fnUntraced(function* (cue) {
      if (c.read !== true || cue.text.trim() === "") return [];
      const hits = yield* find(cue.agent, cue.text, recallCount, "note", cue.project);
      return hits
        .filter((h) => cue.skip?.has(h.id) !== true && h.text !== "" && h.scope.kind !== "unknown")
        .slice(0, recallCount)
        .map((h) => ({ id: h.id, line: recallWords.sourceLine("EverOS", clip(h.text, lineMost)), score: h.score }));
    }),
    // A search over every profile has no one owner to ask with: it gives nothing here.
    search: Effect.fnUntraced(function* (q) {
      if (c.read !== true || q.text.trim() === "") return { found: [] };
      if (q.project === "") return { found: [], coverage: t("server.memory.coverage.everosAcross") };
      if (q.agent === "" && q.kind !== "issue") return { found: [], coverage: t("server.memory.coverage.everosAgent") };
      const kind: MemoryKind = q.kind || "note";
      const hits = yield* find(q.agent, q.text, q.limit, kind, q.project);
      return {
        found: hits
          .filter((h) => h.text !== "")
          .map((h) => ({ id: h.id, agent: q.agent, kind, text: h.text, at: 0, recalled: 0, fading: false, source: "everos", score: h.score, scope: h.scope })),
      };
    }),
    list: () => Effect.fail(new SourceError({ message: t("server.memory.everosList") })),
    // The job once per session, then what the helper said; a failed run says so. A stopped run leaves nothing.
    syncTurn: Effect.fnUntraced(function* (run) {
      if (c.write !== true || run.outcome === "interrupted") return;
      const at = yield* Clock.currentTimeMillis;
      const messages: Message[] = [];
      if (!told.has(run.session) && run.job.trim() !== "") messages.push({ sender_id: user, role: "user", timestamp: at, content: run.job });
      let said = run.said.trim() === "" ? run.summary : run.said;
      if (run.outcome === "failed") said = everosWords.failed + said;
      if (said.trim() !== "") messages.push({ sender_id: agentOf(run.agent), role: "assistant", timestamp: at, content: said });
      if (messages.length === 0) return;
      yield* add(sessionOf(run.session), run.project, messages);
      told.add(run.session);
    }),
    sessionEnded: Effect.fnUntraced(function* (s) {
      const session = sessionOf(s.session);
      const project = pending.get(session);
      pending.delete(session);
      told.delete(s.session);
      if (project !== undefined) yield* flush(session, project);
    }),
    // A note written outside a run is a conversation of its own, extracted at once.
    add: Effect.fnUntraced(function* (n) {
      if (c.write !== true) return undefined;
      const session = `vibevalley-note-${n.agent}-${newId()}`;
      const project = n.project.trim();
      const at = yield* Clock.currentTimeMillis;
      yield* add(session, project, [
        { sender_id: user, role: "user", timestamp: at, content: everosWords.remember(project, n.text) },
        { sender_id: agentOf(n.agent), role: "assistant", timestamp: at, content: everosWords.noted(n.text) },
      ]);
      yield* Effect.ensuring(
        flush(session, project),
        Effect.sync(() => pending.delete(session)),
      );
      return undefined;
    }),
    forget: () => Effect.fail(new SourceError({ message: t("server.memory.everosForget") })),
    can: { list: false, forget: false, transcripts: true },
  };
}
