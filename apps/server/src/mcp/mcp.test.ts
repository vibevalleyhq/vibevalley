import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import type { Agent, Session } from "@vibevalley/protocol";
import { messagesIn } from "../channel/state.ts";
import { seedAgents } from "../agent/seed.ts";
import { Effect } from "effect";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Docs } from "../doc/doc.ts";
import { Issues } from "../issue/issue.ts";
import { Memories } from "../memory/memory.ts";
import { world } from "../testing/world.ts";
import { Mcp } from "./mcp.ts";
import { until } from "../testing/until.ts";
import { sessionId } from "@vibevalley/protocol/schema";

const lab = (): Agent => ({ ...seedAgents().find((a) => a.id === "lab")!, effort: "" });

interface Answer {
  readonly result?: { readonly content?: { readonly text: string }[]; readonly tools?: { readonly name: string }[] };
  readonly error?: unknown;
}

/** An MCP client of one token, straight at the handler, as a coding agent's would be over HTTP. */
const client = (mcp: Mcp["Service"], token: string) => {
  let id = 0;
  const post = async (body: unknown) => {
    const res = await mcp.handle(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) },
        body: JSON.stringify(body),
      }),
    );
    const raw = await res.text();
    return raw ? (JSON.parse(raw) as Answer) : {};
  };
  const call = (method: string, params: unknown) => post({ jsonrpc: "2.0", id: ++id, method, params });
  return {
    init: () => call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    list: async () => ((await call("tools/list", {})).result?.tools ?? []).map((t) => t.name),
    tool: async (name: string, args: Record<string, unknown> = {}) =>
      ((await call("tools/call", { name, arguments: args })).result?.content ?? []).map((c) => c.text).join(""),
  };
};

const hired = (core: Core["Service"], s: Partial<Session> & { id: string }) =>
  core.apply({
    type: "hired",
    session: {
      name: s.id,
      agent: "",
      runtime: "pi",
      brief: "",
      hiredAt: 0,
      runs: 0,
      phase: { _tag: "working", doing: { action: "thinking", label: "" } },
      ...s,
    } as Session,
  });

describe("mcp", () => {
  it.live("gives a session its tools, as itself", () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers?.authorization ?? "").replace(/^Bearer /, ""));
        turn.say("做完了");
      },
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      const mcp = yield* Mcp;
      const got = yield* issues.hire(lab(), "写 hello", "chat-j");
      const id = got.session!.id;
      yield* until(() => tokens.length > 0, "the session's token");
      let thread: string | undefined;
      yield* Effect.promise(async () => {
        for (let i = 0; i < 500 && !thread; i++) {
          thread = await Effect.runPromise(chat.jobThread(id));
          if (!thread) await new Promise((r) => setTimeout(r, 10));
        }
      });
      const c = client(mcp, tokens[0]!);
      yield* Effect.promise(c.init);
      expect((yield* Effect.promise(c.list)).sort()).toEqual([
        "channel_inbox",
        "channel_say",
        "doc_append",
        "doc_read",
        "doc_update",
        "issue_split",
        "memory_add",
        "memory_search",
        "read_chat",
        "session_list",
      ]);
      const who = yield* Effect.promise(() => c.tool("session_list"));
      expect(who).toMatch(new RegExp(`^- ${id} `, "m"));
      // Names are listed without an @: models copy a wake.
      expect(who.split("\n").slice(0, -1).join("\n")).not.toContain("@");
      expect(yield* Effect.promise(() => c.tool("channel_say", { text: "从 MCP 说一句", anyway: true }))).toContain("发出去了");
      const m = messagesIn(core.state().chat, thread!).find((x) => x.text === "从 MCP 说一句");
      expect(m).toMatchObject({ from: id, fromKind: "agent" });
      expect(yield* Effect.promise(() => c.tool("channel_inbox"))).not.toBe("");
      expect(yield* Effect.promise(() => c.tool("read_chat"))).toContain("从 MCP 说一句");
      expect(yield* Effect.promise(() => client(mcp, "").tool("session_list"))).toContain("没认出你是谁");
      expect(yield* Effect.promise(() => client(mcp, "hb_w1_forged").tool("channel_say", { text: "冒名" }))).toContain("没认出你是谁");
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [pi], repos: ["chat-j"] })));
  });

  it.live("lists sessions by their phase", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      yield* hired(core, { id: sessionId("failed"), name: "失败的", phase: { _tag: "failed" } });
      yield* hired(core, { id: sessionId("resting"), name: "歇着的", phase: { _tag: "resting" } });
      yield* hired(core, { id: sessionId("clash"), name: "冲突的", phase: { _tag: "done" }, conflict: { base: "main", files: ["a.go"] } });
      const text = yield* Effect.promise(() => client(mcp, "token").tool("session_list"));
      for (const want of ["这一轮没做成", "歇着（上一轮没做完）", "合进 main 会冲突（a.go）"]) expect(text).toContain(want);
    }).pipe(Effect.scoped, Effect.provide(world({ who: () => "caller" }))),
  );

  it.live("calls no tool for a caller it does not know", () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const c = client(mcp, "");
      for (const name of yield* Effect.promise(c.list)) {
        const args = name === "channel_say" || name === "memory_add" ? { text: "must not be posted" } : {};
        expect(yield* Effect.promise(() => c.tool(name, args))).toContain("没认出你是谁");
      }
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("lets a helper search and write only its own memory", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      const memory = yield* Memories;
      yield* hired(core, { id: sessionId("w1"), name: "一号", agent: "lab", project: "demo" });
      yield* memory.write({ agent: "scout", text: "这个项目测试用 make check", project: "demo", by: "owner" });
      const c = client(mcp, "w1");
      const tool = (name: string, args: Record<string, unknown>) => Effect.promise(() => c.tool(name, args));
      expect(yield* tool("memory_add", { text: "这个项目测试用 pnpm test" })).toContain("记下了（项目 demo）");
      expect(yield* tool("memory_add", { text: "提交信息写中文", all_projects: true })).toContain("记下了（所有项目）");
      expect(yield* tool("memory_add", { text: "冒名记一条", agent: "scout" })).toContain("只能记进你自己的档案");
      expect((yield* memory.list("scout")).some((m) => m.text === "冒名记一条")).toBe(false);
      // What it wrote is its own, not the owner's: the 记性 tab says which helper wrote it.
      for (const m of yield* memory.list("lab")) expect([m.author, m.session]).toEqual(["agent", "w1"]);
      const found = yield* tool("memory_search", { query: "测试" });
      expect(found).toContain("pnpm test");
      expect(found).not.toContain("make check");
      expect(yield* tool("memory_search", { query: "部署" })).toContain("没有搜到「部署」");
      expect(yield* Effect.promise(() => client(mcp, "w9").tool("memory_search", { query: "测试" }))).toContain("你不在场");
    }).pipe(Effect.scoped, Effect.provide(world({ who: (token) => token }))),
  );

  // A helper writes a document through its tools: the same ops as the owner's editor, written as its profile; a stale
  // rewrite over the owner's change is not taken and says what the block has now.
  it.live("lets a helper write a document", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      const docs = yield* Docs;
      yield* hired(core, { id: sessionId("w1"), name: "一号", agent: "lab" });
      const d = yield* docs.create("周报");
      const c = client(mcp, "w1");
      const tool = (name: string, args: Record<string, unknown>) => Effect.promise(() => c.tool(name, args));
      const added = yield* tool("doc_append", { doc: d.doc.id, text: "这周做完了**第一步**" });
      const block = /加了一块〔(\S+)〕，第 (\d+) 版/.exec(added)![1]!;
      expect(yield* tool("doc_append", { doc: d.doc.id, text: "下周", type: "heading", level: 1 })).toContain("加了一块");
      expect(yield* tool("doc_append", { doc: d.doc.id, text: "x", type: "table" })).toContain("没成：块的类型只能是");
      const read = yield* tool("doc_read", { doc: d.doc.id });
      expect(read).toContain("《周报》，2 块");
      expect(read).toContain("〔" + block + " · 第 1 版 · paragraph〕这周做完了第一步");
      expect(yield* tool("doc_update", { doc: d.doc.id, block, base_rev: 1, text: "这周做完了第一步和第二步" })).toContain("现在是第 2 版");
      // The owner changes it in the editor; the helper's next rewrite was made against rev 2.
      yield* docs.submit(d.doc.id, "owner", {
        batchId: "owner",
        ops: [{ op: "update_text", blockId: block, baseRev: 2, text: [{ t: "主人改过的", marks: {} }] }],
      });
      const stale = yield* tool("doc_update", { doc: d.doc.id, block, base_rev: 2, text: "帮工又改" });
      expect(stale).toContain("没改：这一块刚被别人改过，现在是第 3 版");
      expect(stale).toContain("主人改过的");
      const snap = yield* docs.get(d.doc.id);
      expect([snap.blocks[0]!.text[0]!.t, snap.blocks[0]!.updatedBy, snap.blocks[1]!.updatedBy]).toEqual(["主人改过的", "owner", "lab"]);
      expect(yield* docs.markdown(d.doc.id)).toBe("主人改过的\n\n# 下周\n");
      expect(yield* tool("doc_read", { doc: "nope" })).toContain("没成");
    }).pipe(Effect.scoped, Effect.provide(world({ who: (token) => token }))),
  );
});
