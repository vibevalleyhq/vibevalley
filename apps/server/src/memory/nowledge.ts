// Nowledge Mem (https://mem.nowledge.co), a knowledge graph on this Mac, spoken to over MCP: memory_search reads, memory_add writes. It is the owner's own knowledge, and the farm only adds to it. What
// the farm writes carries labels, vibevalley and the profile's, so that a profile reads back its own; with everything it
// reads all that is in it. Whatever is sent is redacted: a run's words may carry a key.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Memory } from "@vibevalley/protocol";
import { redact } from "../base/redact.ts";
import type { MemorySourceConfig } from "../setting/rules.ts";
import { memoryNotesOf, recallCount, clip } from "./recall.ts";
import { prefetchTimeoutMs, type Source } from "./sources.ts";

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
const label = (kind: string, name: string) => `${app}-${kind}-${name.replace(/[\s,]+/g, "-")}`;

export const nowledgeLabels = (agent: string, project: string) => [app, label("agent", agent), ...(project ? [label("project", project)] : [])].join(",");

interface Hit {
  readonly id?: string;
  readonly memory_id?: string;
  readonly title?: string;
  readonly content?: string;
  readonly content_preview?: string;
  readonly relevance_score?: number;
}

const hitID = (h: Hit) => h.memory_id || h.id || "";

function hitText(h: Hit): string {
  const body = h.content_preview || h.content || "";
  return !h.title || body.startsWith(h.title) ? body : `${h.title}：${body}`;
}

export function nowledge(c: MemorySourceConfig): Source {
  let client: Promise<Client> | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  // The session opens on first use: Nowledge not running when the farm starts must not keep it off until a restart.
  const open = () =>
    (client ??= (async () => {
      transport = new StreamableHTTPClientTransport(new URL(c.url), { requestInit: c.key ? { headers: { Authorization: `Bearer ${c.key}` } } : undefined });
      const one = new Client({ name: app, version: "1" });
      await one.connect(transport, { timeout: prefetchTimeoutMs });
      return one;
    })().catch((e: unknown) => {
      client = undefined;
      throw e;
    }));

  /** One tool call; its answer is the text of the result. A session that failed is dropped, so the next call opens another. */
  const call = async (tool: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const session = await open();
    let res;
    try {
      res = await session.callTool({ name: tool, arguments: args }, undefined, { signal });
    } catch (e) {
      if (!signal.aborted) {
        client = undefined;
        void session.close();
      }
      throw e;
    }
    const text = ((res.content ?? []) as { type: string; text?: string }[]).map((x) => (x.type === "text" ? (x.text ?? "") : "")).join("");
    if (res.isError) throw new Error(`${tool}: ${head(text, 300)}`);
    return text;
  };

  /** agent "" reads what the farm wrote for any profile; everything reads all that is in it. */
  const find = async (agent: string, query: string, limit: number, everything: boolean, signal: AbortSignal): Promise<Hit[]> => {
    const args: Record<string, unknown> = { limit: Math.max(1, Math.min(limit, most)), source_app: app };
    // Its search without a query lists nothing; filtered by labels, any query finds all they hold.
    const q = head(redact(query).trim(), queryMost) || (everything ? "" : "*");
    if (q !== "") args.query = q;
    if (!everything) args.filter_labels = agent ? label("agent", agent) : app;
    const text = await call("memory_search", args, signal);
    try {
      return (JSON.parse(text) as { results?: Hit[] }).results ?? [];
    } catch {
      throw new Error("memory_search answered what it should not: " + head(text, 200));
    }
  };

  const add = async (agent: string, text: string, project: string, signal: AbortSignal) => {
    const body = redact(text);
    const answer = await call("memory_add", { content: body, title: head(body, 60), labels: nowledgeLabels(agent, project), source_app: app }, signal);
    // The new memory's id, at the top or under memory; none when it found the same memory there already.
    let added: { id?: string; memory_id?: string; memory?: { id?: string } } = {};
    try {
      added = JSON.parse(answer) as typeof added;
    } catch {
      // No id to give back.
    }
    return added.memory_id || added.id || added.memory?.id || "";
  };

  return {
    name: "nowledge",
    unavailable: () => (c.url ? undefined : "没填地址"),
    // Closing the transport ends a connect still waiting on a Nowledge that does not answer.
    stop: async () => {
      const was = transport;
      client = undefined;
      transport = undefined;
      await was?.close().catch(() => {});
    },
    // Nothing to ask with, nothing asked: listing its newest would only be noise at the start of a run.
    prefetch: async (cue, signal) => {
      if (!c.read || cue.text.trim() === "") return [];
      const hits = await find(cue.agent, cue.text, recallCount, !!c.everything, signal);
      return hits
        .filter((h) => !cue.skip?.has(hitID(h)))
        .map((h) => ({ id: hitID(h), line: "- （Nowledge）" + clip(hitText(h), lineMost), score: h.relevance_score ?? 0 }));
    },
    // Its memories are notes; it has no jobs done.
    search: async (q, signal) => {
      if (!c.read || q.kind === "issue") return [];
      const hits = await find(q.agent, q.text, q.limit, !!c.everything, signal);
      return hits.map(
        (h) =>
          ({ id: hitID(h), agent: q.agent, kind: "note", text: hitText(h), at: 0, recalled: 0, source: "nowledge", score: h.relevance_score ?? 0 }) as never,
      );
    },
    // The farm's own; Nowledge does not say which project each is for.
    list: async (agent, signal) => {
      if (!c.read) return [];
      const hits = await find(agent, "", most, false, signal);
      return hits.map((h) => ({ id: hitID(h), agent, kind: "note", text: hitText(h), at: 0, recalled: 0 }) as Memory);
    },
    // The 「记住：」 lines; a stopped run leaves nothing here either.
    syncTurn: async (run, signal) => {
      if (!c.write || run.outcome === "interrupted") return;
      for (const note of memoryNotesOf(run.said)) await add(run.agent, note.text, note.everywhere ? "" : run.project, signal);
    },
    sessionEnded: async () => {},
    add: async (n, signal) => {
      if (!c.write) return undefined;
      const project = n.project.trim();
      const id = await add(n.agent, n.text, project, signal);
      return { id, agent: n.agent, kind: "note", text: n.text, at: Date.now(), recalled: 0, ...(project ? { project } : {}) } as Memory;
    },
    forget: async () => {
      throw new Error("Nowledge Mem 里的记忆到 Nowledge Mem 里删");
    },
    can: { list: true, forget: false, transcripts: false },
  };
}
