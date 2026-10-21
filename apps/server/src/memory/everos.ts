// EverOS (github.com/EverMind-AI/EverOS) over its HTTP API, /api/v2. It is given whole
// runs and extracts memories itself with a model: memory/add takes a session's messages, memory/flush makes it extract
// them (here when the session leaves the farm), memory/search reads back. What a helper says is the agent's (agent_id,
// read back as agent_cases), what it was asked is the owner's (user_id, read back as episodes). Every message is redacted
// first: a helper's words may carry a key.

import type { Memory, MemoryKind } from "@vibevalley/protocol";
import { newId } from "../base/ids.ts";
import { redact } from "../base/redact.ts";
import type { MemorySourceConfig } from "../setting/rules.ts";
import { clip, recallCount } from "./recall.ts";
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

interface FoundBody {
  readonly data?: {
    readonly episodes?: readonly { id: string; subject?: string; summary?: string; episode?: string; score?: number }[];
    readonly agent_cases?: readonly { id: string; task_intent?: string; approach?: string; key_insight?: string; score?: number }[];
  };
}

/** A farm's session ids (w1, w2…) are its own only: another farm on the same EverOS has a w1 too. */
const sessionOf = (session: string) => `${app}-${session}`;
const agentOf = (agent: string) => `${app}-${agent}`;

export function everos(c: MemorySourceConfig): Source {
  const user = c.user || "owner";
  /** Sessions given messages and not yet told to extract; flushed when the session ends, or when the farm stops. */
  const pending = new Map<string, string>();
  /** Sessions whose job it was given already: a later run sends only what the helper said. */
  const told = new Set<string>();

  const post = async (path: string, body: unknown, signal: AbortSignal) => {
    const res = await fetch(`${c.url.replace(/\/+$/, "")}/api/v2/memory/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    const text = (await res.text()).slice(0, 4 << 20);
    if (!res.ok) throw new Error(`memory/${path}: ${res.status} ${text.slice(0, 300)}`);
    return text;
  };

  const add = async (session: string, project: string, messages: Message[], signal: AbortSignal) => {
    for (const m of messages) m.content = redact(m.content);
    await post("add", { session_id: session, messages, app_id: app, ...(project ? { project_id: project } : {}) }, signal);
    pending.set(session, project);
  };

  const flush = (session: string, project: string, signal: AbortSignal) =>
    post("flush", { session_id: session, app_id: app, ...(project ? { project_id: project } : {}) }, signal);

  /** A profile's cases, or with kind issue the owner's episodes. */
  const find = async (agent: string, query: string, limit: number, kind: MemoryKind, signal: AbortSignal) => {
    const body = {
      query: redact(query).trim().slice(0, 1000),
      top_k: Math.max(1, Math.min(limit, most)),
      ...(kind === "issue" ? { user_id: user } : { agent_id: agentOf(agent) }),
    };
    const text = await post("search", body, signal);
    let found: FoundBody;
    try {
      found = JSON.parse(text) as FoundBody;
    } catch {
      throw new Error("memory/search answered what it should not: " + text.slice(0, 200));
    }
    const hits: { id: string; text: string; score: number }[] = [];
    for (const k of found.data?.agent_cases ?? [])
      hits.push({
        id: k.id,
        text: [k.task_intent, k.approach, k.key_insight]
          .map((p) => (p ?? "").trim())
          .filter((p) => p !== "")
          .join("；"),
        score: k.score ?? 0,
      });
    for (const ep of found.data?.episodes ?? []) {
      const t = ep.summary || ep.episode || "";
      hits.push({ id: ep.id, text: ep.subject ? `${ep.subject}：${t}` : t, score: ep.score ?? 0 });
    }
    return hits;
  };

  return {
    name: "everos",
    unavailable: () => (c.url ? undefined : "没填地址"),
    // What it was given and not told to extract yet is extracted now: EverOS only extracts on a flush.
    stop: async () => {
      const all = [...pending];
      pending.clear();
      for (const [session, project] of all) await flush(session, project, AbortSignal.timeout(prefetchTimeoutMs)).catch(() => {});
    },
    prefetch: async (cue, signal) => {
      if (!c.read || cue.text.trim() === "") return [];
      const hits = await find(cue.agent, cue.text, recallCount, "note", signal);
      return hits
        .filter((h) => !cue.skip?.has(h.id) && h.text !== "")
        .map((h) => ({ id: h.id, line: "- （EverOS）" + clip(h.text, lineMost), score: h.score }));
    },
    // A search over every profile has no one owner to ask with: it gives nothing here.
    search: async (q, signal) => {
      if (!c.read || q.text.trim() === "" || (q.agent === "" && q.kind !== "issue")) return [];
      const kind: MemoryKind = q.kind || "note";
      const hits = await find(q.agent, q.text, q.limit, kind, signal);
      return hits
        .filter((h) => h.text !== "")
        .map((h) => ({ id: h.id, agent: q.agent, kind, text: h.text, at: 0, recalled: 0, source: "everos", score: h.score }) as never);
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
      if (said.trim() !== "") messages.push({ sender_id: agentOf(run.agent), role: "assistant", timestamp: now, content: said });
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
          { sender_id: user, role: "user", timestamp: now, content: `记住（${project ? `项目 ${project}` : "所有项目"}）：${n.text}` },
          { sender_id: agentOf(n.agent), role: "assistant", timestamp: now, content: `记下了：${n.text}` },
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
