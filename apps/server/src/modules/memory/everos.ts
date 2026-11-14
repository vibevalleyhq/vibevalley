import { createHash } from "node:crypto";

import { z } from "zod";

import { isAbort, withTimeout } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type { MemoryKind } from "@vibevalley/protocol";

import { clip } from "#/base/clip.ts";
import { newId } from "#/base/ids.ts";
import { redact, type RedactedString, redactedHead } from "#/base/redact.ts";
import type { MemorySourceConfig } from "#/platform/setting/memorySources.ts";

import { everosWords, recallWords } from "./prompts.ts";
import { recallCount, type MemoryScope } from "./recall.ts";
import { prefetchTimeoutMs, type Source, type SourceDeps, SourceError, sourceError, sourceLife } from "./sources.ts";

/** app_id on everything written, so its memories can be told from another app's. */
const app = "vibevalley";
const most = 100;
const lineMost = 200;

interface Message {
  readonly sender_id: string;
  readonly role: "user" | "assistant";
  readonly timestamp: number;
  readonly content: string;
}

/** What goes to EverOS: every message's words redacted. */
type Sent = Omit<Message, "content"> & { readonly content: RedactedString };
type Scoped = { readonly app_id: string; readonly repo_id: string };
type Body =
  | (Scoped & { readonly session_id: string; readonly messages: Sent[] })
  | (Scoped & { readonly session_id: string })
  | (Scoped & { readonly query: RedactedString; readonly top_k: number; readonly user_id?: string; readonly agent_id?: string });

const Episode = z.object({
  id: z.string(),
  subject: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
  episode: z.exactOptional(z.string()),
  score: z.exactOptional(z.number()),
  app_id: z.exactOptional(z.string()),
  repo_id: z.exactOptional(z.string()),
});
const AgentCase = z.object({
  id: z.string(),
  task_intent: z.exactOptional(z.string()),
  approach: z.exactOptional(z.string()),
  key_insight: z.exactOptional(z.string()),
  score: z.exactOptional(z.number()),
  app_id: z.exactOptional(z.string()),
  repo_id: z.exactOptional(z.string()),
});
const FoundPayload = z.object({
  data: z.exactOptional(z.object({ episodes: z.exactOptional(z.array(Episode)), agent_cases: z.exactOptional(z.array(AgentCase)) })),
});

const decodedFound = (text: string) => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not JSON: the caller fails it as an answer it should not have given.
    return undefined;
  }
  const got = FoundPayload.safeParse(raw);
  return got.success ? got.data : undefined;
};

// EverOS scope ids are ASCII and at most 128 characters; a real repo named "global" must stay separate from global notes.
const scopeOf = (repo: string) => (repo ? "repo-" + createHash("sha256").update(repo).digest("hex") : "global");

/** A farm's session ids (w1, w2…) are its own only: another farm on the same EverOS has a w1 too. */
const sessionOf = (session: string) => `${app}-${session}`;
const agentOf = (agent: string) => `${app}-${agent}`;

/** deps.fetch: the farm's; aborting a call's signal aborts its request. */
export function everos(c: MemorySourceConfig, deps: SourceDeps): Source {
  const life = sourceLife("EverOS");
  const user = c.user || "owner";
  /** Sessions given messages and not yet told to extract; flushed when the session ends, or when the farm stops. */
  const pending = new Map<string, string>();
  /** Sessions whose brief it was given already: a later run sends only what the helper said. */
  const told = new Set<string>();

  /** The answer's text; closing: the flush as it stops, which its stop does not cut short. */
  const key = c.key === undefined ? "" : c.key.reveal();
  const post = (path: "add" | "flush" | "search", body: Body, signal: AbortSignal, closing = false) => {
    const answer = async (s: AbortSignal) => {
      try {
        const res = await deps.fetch(`${c.url.replace(/\/+$/u, "")}/api/v2/memory/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(body),
          signal: s,
        });
        const text = (await res.text()).slice(0, 4 << 20);
        if (res.status < 200 || res.status >= 300) throw new SourceError(`memory/${path}: ${res.status} ${text.slice(0, 300)}`);
        return text;
      } catch (e) {
        if (isAbort(e, s)) throw e;
        throw sourceError(e);
      }
    };
    return closing ? answer(signal) : life.alive(answer, signal);
  };

  const add = async (session: string, repo: string, messages: Message[], signal: AbortSignal) => {
    const sent: Sent[] = messages.map((m) => ({ ...m, content: redact(m.content) }));
    await post("add", { session_id: session, messages: sent, app_id: app, repo_id: scopeOf(repo) }, signal);
    pending.set(session, repo);
  };

  const flush = (session: string, repo: string, signal: AbortSignal, closing = false) =>
    post("flush", { session_id: session, app_id: app, repo_id: scopeOf(repo) }, signal, closing);

  /** A profile's cases, or with kind issue the user's episodes. */
  const findIn = async (agent: string, query: string, limit: number, kind: MemoryKind, repo: string, signal: AbortSignal) => {
    const scope = scopeOf(repo);
    const body = {
      app_id: app,
      repo_id: scope,
      query: redactedHead(redact(query), 1000),
      top_k: Math.max(1, Math.min(limit, most)),
      ...(kind === "issue" ? { user_id: user } : { agent_id: agentOf(agent) }),
    };
    const text = await post("search", body, signal);
    const found = decodedFound(text);
    if (!found) throw new SourceError("memory/search answered what it should not: " + text.slice(0, 200));
    const ownership = (hit: { app_id?: string; repo_id?: string }): MemoryScope =>
      hit.app_id !== app || hit.repo_id !== scope ? { kind: "unknown" } : repo ? { kind: "repo", repo } : { kind: "global" };
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
  };

  const find = async (agent: string, query: string, limit: number, kind: MemoryKind, repo: string, signal: AbortSignal) => {
    const all = await Promise.all((repo ? [repo, ""] : [""]).map((p) => findIn(agent, query, limit, kind, p, signal)));
    return all.flat().toSorted((a, b) => b.score - a.score);
  };

  return {
    name: "everos",
    unavailable: () => (c.url ? undefined : t("server.memory.noUrl")),
    // What it was given and not told to extract yet is extracted now: EverOS only extracts on a flush.
    stop: async () => {
      if (!life.stop()) return;
      const all = [...pending];
      pending.clear();
      told.clear();
      try {
        await withTimeout(
          (signal) =>
            Promise.all(
              all.map(([session, repo]) =>
                flush(session, repo, signal, true).catch((e: unknown) => {
                  if (!isAbort(e, signal)) deps.log.warn(`vibevalley: everos: session ${session} was not flushed at stop`, e);
                }),
              ),
            ),
          prefetchTimeoutMs,
          { clock: deps.clock },
        );
      } catch (e) {
        // The flushes that did not finish in time are left: stopping does not wait longer for EverOS.
        if (!isAbort(e)) throw e;
      }
    },
    prefetch: async (cue, signal) => {
      if (c.read !== true || cue.text.trim() === "") return [];
      const hits = await find(cue.agent, cue.text, recallCount, "note", cue.repo, signal);
      return hits
        .filter((h) => cue.skip?.has(h.id) !== true && h.text !== "" && h.scope.kind !== "unknown")
        .slice(0, recallCount)
        .map((h) => ({ id: h.id, line: recallWords.sourceLine("EverOS", clip(h.text, lineMost)), score: h.score }));
    },
    // A search over every profile has no one user to ask with: it gives nothing here.
    search: async (q, signal) => {
      if (c.read !== true || q.text.trim() === "") return { found: [] };
      if (q.repo === "") return { found: [], coverage: t("server.memory.coverage.everosAcross") };
      if (q.agent === "" && q.kind !== "issue") return { found: [], coverage: t("server.memory.coverage.everosAgent") };
      const kind: MemoryKind = q.kind || "note";
      const hits = await find(q.agent, q.text, q.limit, kind, q.repo, signal);
      return {
        found: hits
          .filter((h) => h.text !== "")
          .map((h) => ({
            id: h.id,
            agent: q.agent,
            kind,
            text: h.text,
            author: "system",
            at: 0,
            recalled: 0,
            fading: false,
            source: "everos",
            score: h.score,
            scope: h.scope,
          })),
      };
    },
    list: async () => {
      throw new SourceError(t("server.memory.everosList"));
    },
    // The brief once per session, then what the helper said. a failed run says so.
    syncTurn: async (run, signal) => {
      if (c.write !== true || run.outcome === "interrupted") return;
      const at = deps.clock.now();
      const messages: Message[] = [];
      if (!told.has(run.session) && run.brief.trim() !== "") messages.push({ sender_id: user, role: "user", timestamp: at, content: run.brief });
      let said = run.said.trim() === "" ? run.summary : run.said;
      if (run.outcome === "failed") said = everosWords.failed + said;
      if (said.trim() !== "") messages.push({ sender_id: agentOf(run.agent), role: "assistant", timestamp: at, content: said });
      if (messages.length === 0) return;
      await add(sessionOf(run.session), run.repo, messages, signal);
      told.add(run.session);
    },
    sessionEnded: async (s, signal) => {
      const session = sessionOf(s.session);
      const repo = pending.get(session);
      pending.delete(session);
      told.delete(s.session);
      if (repo !== undefined) await flush(session, repo, signal);
    },
    // A note written outside a run is a conversation of its own, extracted at once.
    add: async (n, signal) => {
      if (c.write !== true) return undefined;
      const session = `vibevalley-note-${n.agent}-${newId()}`;
      const repo = n.repo.trim();
      const at = deps.clock.now();
      await add(
        session,
        repo,
        [
          { sender_id: user, role: "user", timestamp: at, content: everosWords.remember(repo, n.text) },
          { sender_id: agentOf(n.agent), role: "assistant", timestamp: at, content: everosWords.noted(n.text) },
        ],
        signal,
      );
      try {
        await flush(session, repo, signal);
      } finally {
        pending.delete(session);
      }
      return undefined;
    },
    forget: async () => {
      throw new SourceError(t("server.memory.everosForget"));
    },
    can: { list: false, forget: false, transcripts: true },
  };
}
