// EverOS (github.com/EverMind-AI/EverOS) over its HTTP API, /api/v2. It is given whole
// runs and extracts memories itself with a model: memory/add takes a session's messages, memory/flush makes it extract
// them (here when the session leaves the farm), memory/search reads back. What a helper says is the agent's (agent_id,
// read back as agent_cases), what it was asked is the owner's (user_id, read back as episodes). Every message is redacted
// first: a helper's words may carry a key.

import type { Memory, MemoryKind } from "@vibevalley/protocol";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { outside } from "../base/http.ts";
import { newId } from "../base/ids.ts";
import { jsonOrNone } from "../base/json.ts";
import { redact } from "../base/redact.ts";
import type { MemorySourceConfig } from "../setting/rules.ts";
import { clip, recallCount, type MemoryScope } from "./recall.ts";
import { prefetchTimeoutMs, type Source } from "./sources.ts";

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

const ownedBy = {
  app_id: Schema.optionalKey(Schema.String),
  project_id: Schema.optionalKey(Schema.String),
};
const score = Schema.optionalKey(Schema.Number);
const readFound = jsonOrNone(
  Schema.Struct({
    data: Schema.optionalKey(
      Schema.Struct({
        episodes: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              subject: Schema.optionalKey(Schema.String),
              summary: Schema.optionalKey(Schema.String),
              episode: Schema.optionalKey(Schema.String),
              score,
              ...ownedBy,
            }),
          ),
        ),
        agent_cases: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              task_intent: Schema.optionalKey(Schema.String),
              approach: Schema.optionalKey(Schema.String),
              key_insight: Schema.optionalKey(Schema.String),
              score,
              ...ownedBy,
            }),
          ),
        ),
      }),
    ),
  }),
);

// EverOS scope ids are ASCII and at most 128 characters; a real project named "global" must stay separate from global notes.
const scopeOf = (project: string) => (project ? "project-" + createHash("sha256").update(project).digest("hex") : "global");

/** A farm's session ids (w1, w2…) are its own only: another farm on the same EverOS has a w1 too. */
const sessionOf = (session: string) => `${app}-${session}`;
const agentOf = (agent: string) => `${app}-${agent}`;

export function everos(c: MemorySourceConfig): Source {
  let closed = false;
  const life = new AbortController();
  const user = c.user || "owner";
  /** Sessions given messages and not yet told to extract; flushed when the session ends, or when the farm stops. */
  const pending = new Map<string, string>();
  /** Sessions whose job it was given already: a later run sends only what the helper said. */
  const told = new Set<string>();

  const post = (path: string, body: unknown, signal: AbortSignal, closing = false) =>
    outside(
      Effect.gen(function* () {
        const request = HttpClientRequest.post(`${c.url.replace(/\/+$/, "")}/api/v2/memory/${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
        const res = yield* HttpClient.execute(c.key ? HttpClientRequest.bearerToken(request, c.key) : request);
        const text = (yield* res.text).slice(0, 4 << 20);
        if (res.status < 200 || res.status > 299) return yield* Effect.fail(new Error(`memory/${path}: ${res.status} ${text.slice(0, 300)}`));
        return text;
      }),
      closing ? signal : AbortSignal.any([signal, life.signal]),
    );

  const add = async (session: string, project: string, messages: Message[], signal: AbortSignal) => {
    for (const m of messages) m.content = redact(m.content);
    await post("add", { session_id: session, messages, app_id: app, project_id: scopeOf(project) }, signal);
    pending.set(session, project);
  };

  const flush = (session: string, project: string, signal: AbortSignal, closing = false) =>
    post("flush", { session_id: session, app_id: app, project_id: scopeOf(project) }, signal, closing);

  /** A profile's cases, or with kind issue the owner's episodes. */
  const findIn = async (agent: string, query: string, limit: number, kind: MemoryKind, project: string, signal: AbortSignal) => {
    const scope = scopeOf(project);
    const body = {
      app_id: app,
      project_id: scope,
      query: redact(query).trim().slice(0, 1000),
      top_k: Math.max(1, Math.min(limit, most)),
      ...(kind === "issue" ? { user_id: user } : { agent_id: agentOf(agent) }),
    };
    const text = await post("search", body, signal);
    const found = readFound(text);
    if (!found) throw new Error("memory/search answered what it should not: " + text.slice(0, 200));
    const ownership = (hit: { app_id?: string; project_id?: string }): MemoryScope =>
      hit.app_id !== app || hit.project_id !== scope ? { kind: "unknown" } : project ? { kind: "project", project } : { kind: "global" };
    const hits: { id: string; text: string; score: number; scope: MemoryScope }[] = [];
    for (const k of found.data?.agent_cases ?? [])
      hits.push({
        id: `${scope}:${k.id}`,
        text: [k.task_intent, k.approach, k.key_insight]
          .map((p) => (p ?? "").trim())
          .filter((p) => p !== "")
          .join("；"),
        score: k.score ?? 0,
        scope: ownership(k),
      });
    for (const ep of found.data?.episodes ?? []) {
      const t = ep.summary || ep.episode || "";
      hits.push({
        id: `${scope}:${ep.id}`,
        text: ep.subject ? `${ep.subject}：${t}` : t,
        score: ep.score ?? 0,
        scope: ownership(ep),
      });
    }
    return hits;
  };

  const find = async (agent: string, query: string, limit: number, kind: MemoryKind, project: string, signal: AbortSignal) =>
    (await Promise.all((project ? [project, ""] : [""]).map((p) => findIn(agent, query, limit, kind, p, signal)))).flat().sort((a, b) => b.score - a.score);

  return {
    name: "everos",
    unavailable: () => (c.url ? undefined : "没填地址"),
    // What it was given and not told to extract yet is extracted now: EverOS only extracts on a flush.
    stop: async () => {
      if (closed) return;
      closed = true;
      life.abort(new Error("EverOS source has stopped"));
      const all = [...pending];
      pending.clear();
      told.clear();
      const signal = AbortSignal.timeout(prefetchTimeoutMs);
      await Promise.allSettled(all.map(([session, project]) => flush(session, project, signal, true)));
    },
    prefetch: async (cue, signal) => {
      if (!c.read || cue.text.trim() === "") return [];
      const hits = await find(cue.agent, cue.text, recallCount, "note", cue.project, signal);
      return hits
        .filter((h) => !cue.skip?.has(h.id) && h.text !== "" && h.scope.kind !== "unknown")
        .slice(0, recallCount)
        .map((h) => ({ id: h.id, line: "- （EverOS）" + clip(h.text, lineMost), score: h.score }));
    },
    // A search over every profile has no one owner to ask with: it gives nothing here.
    search: async (q, signal) => {
      if (!c.read || q.text.trim() === "") return { found: [] };
      if (q.project === "") return { found: [], coverage: "不支持跨项目检索，请指定一个项目；本次未包含 EverOS" };
      if (q.agent === "" && q.kind !== "issue") return { found: [], coverage: "此查询需要指定帮工档案，本次未包含 EverOS" };
      const kind: MemoryKind = q.kind || "note";
      const hits = await find(q.agent, q.text, q.limit, kind, q.project, signal);
      return {
        found: hits
          .filter((h) => h.text !== "")
          .map((h) => ({
            id: h.id,
            agent: q.agent,
            kind,
            text: h.text,
            at: 0,
            recalled: 0,
            source: "everos",
            score: h.score,
            scope: h.scope,
          })),
      };
    },
    list: async () => {
      throw new Error("EverOS 的记忆不在这里列出");
    },
    // The job once per session, then what the helper said; a failed run says so. A stopped run leaves nothing.
    syncTurn: async (run, signal) => {
      if (!c.write || run.outcome === "interrupted") return;
      const now = Date.now();
      const messages: Message[] = [];
      if (!told.has(run.session) && run.job.trim() !== "") messages.push({ sender_id: user, role: "user", timestamp: now, content: run.job });
      let said = run.said.trim() === "" ? run.summary : run.said;
      if (run.outcome === "failed") said = "（这一轮没做成）" + said;
      if (said.trim() !== "")
        messages.push({
          sender_id: agentOf(run.agent),
          role: "assistant",
          timestamp: now,
          content: said,
        });
      if (messages.length === 0) return;
      await add(sessionOf(run.session), run.project, messages, signal);
      told.add(run.session);
    },
    sessionEnded: async (s, signal) => {
      const session = sessionOf(s.session);
      const project = pending.get(session);
      pending.delete(session);
      told.delete(s.session);
      if (project !== undefined) await flush(session, project, signal);
    },
    // A note written outside a run is a conversation of its own, extracted at once.
    add: async (n, signal) => {
      if (!c.write) return undefined;
      const session = `vibevalley-note-${n.agent}-${newId()}`;
      const project = n.project.trim();
      const now = Date.now();
      await add(
        session,
        project,
        [
          {
            sender_id: user,
            role: "user",
            timestamp: now,
            content: `记住（${project ? `项目 ${project}` : "所有项目"}）：${n.text}`,
          },
          {
            sender_id: agentOf(n.agent),
            role: "assistant",
            timestamp: now,
            content: `记下了：${n.text}`,
          },
        ],
        signal,
      );
      try {
        await flush(session, project, signal);
      } finally {
        pending.delete(session);
      }
      return undefined;
    },
    forget: async () => {
      throw new Error("EverOS 里的记忆到 EverOS 里删");
    },
    can: { list: false, forget: false, transcripts: true },
  };
}

export type { Memory };
