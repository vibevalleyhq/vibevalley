import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { Artifact } from "@/artifact/artifact.ts";
import { owner } from "@/base/actor.ts";
import { Channel } from "@/channel/chat.ts";
import { Core } from "@/core/core.ts";
import { Issue } from "@/issue/issue.ts";
import { Memory } from "@/memory/memory.ts";
import { Session } from "@/session/session.ts";
import { starter } from "@/testing/layers.ts";
import { Said } from "@/testing/said.ts";
import { until, waitFor } from "@/testing/until.ts";
import { world } from "@/testing/world.ts";

import { Mcp } from "./mcp.ts";

const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

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

const hired = (core: Core["Service"], s: Partial<T.Session> & { id: string }) =>
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
      refining: false,
    } as T.Session,
  });

describe("mcp", () => {
  it.live("gives a session its tools, as itself", () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        turn.say("做完了");
      },
    });
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channel;
      const mcp = yield* Mcp;
      const got = yield* issues.hire(lab(), "写 hello", "chat-j");
      const id = got.session!.id;
      yield* until(() => tokens.length > 0, "the session's token");
      const thread = yield* waitFor(chat.threadOfSession(id), (t) => t !== undefined, "the session's thread");
      const c = client(mcp, tokens[0]!);
      yield* Effect.promise(c.init);
      expect((yield* Effect.promise(c.list)).toSorted()).toEqual([
        "artifact_block_create",
        "artifact_block_update",
        "artifact_content_get",
        "artifact_create",
        "artifact_get",
        "artifact_list",
        "artifact_version_create",
        "channel_message_list",
        "channel_message_send",
        "channel_unread_list",
        "issue_split",
        "memory_create",
        "memory_search",
        "session_list",
      ]);
      const who = yield* Effect.promise(() => c.tool("session_list"));
      expect(who).toMatch(new RegExp(`^- ${id} `, "mu"));
      // Names are listed without an @: models copy a wake.
      expect(who.split("\n").slice(0, -1).join("\n")).not.toContain("@");
      expect(yield* Effect.promise(() => c.tool("channel_message_send", { text: "从 MCP 说一句", anyway: true }))).toContain("发出去了");
      const m = saidIn(thread!).find((x) => x.text === "从 MCP 说一句");
      expect(m).toMatchObject({ from: id, fromKind: "session" });
      expect(yield* Effect.promise(() => c.tool("channel_unread_list"))).not.toBe("");
      expect(yield* Effect.promise(() => c.tool("channel_message_list"))).toContain("从 MCP 说一句");
      expect(yield* Effect.promise(() => client(mcp, "").tool("session_list"))).toContain("没认出你是谁");
      expect(yield* Effect.promise(() => client(mcp, "hb_w1_forged").tool("channel_message_send", { text: "冒名" }))).toContain("没认出你是谁");
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [pi], repos: ["chat-j"] })));
  });

  it.live("lets a session hand in a file of its working directory as an artifact for its issue, and nothing outside it", () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        turn.say("做完了");
      },
    });
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const chat = yield* Channel;
      const mcp = yield* Mcp;
      const sessions = yield* Session;
      const artifacts = yield* Artifact;
      const got = yield* issues.hire(lab(), "画两种详情", "chat-j");
      const id = got.session!.id;
      yield* until(() => tokens.length > 0, "the session's token");
      const thread = yield* waitFor(chat.threadOfSession(id), (t) => t !== undefined, "the session's thread");
      const cwd = sessions.find(id)!.place.cwd;
      mkdirSync(join(cwd, "out"), { recursive: true });
      writeFileSync(join(cwd, "out", "two.html"), "<p>抽屉和整页</p>");
      const c = client(mcp, tokens[0]!);
      yield* Effect.promise(c.init);
      const made = yield* Effect.promise(() => c.tool("artifact_create", { title: "两种详情", kind: "html", file: "out/two.html", note: "抽屉和整页" }));
      expect(made).toContain("做好了");
      const issue = sessions.sessionOf(id)!.issue!;
      const [one] = yield* artifacts.list({ issue });
      expect(one).toMatchObject({ title: "两种详情", channel: thread, by: "lab", version: 1 });
      expect((yield* chat.history(thread!)).at(-1)!.artifact).toMatchObject({ id: one!.id, version: 1 });
      expect(yield* artifacts.content(one!.id)).toMatchObject({ content: "<p>抽屉和整页</p>" });
      expect(yield* Effect.promise(() => c.tool("artifact_list"))).toContain(one!.id);
      expect(yield* Effect.promise(() => c.tool("artifact_version_create", { id: one!.id, content: "<p>改了</p>", note: "照评论改" }))).toContain("第 2 版");
      expect(yield* Effect.promise(() => c.tool("artifact_content_get", { id: one!.id, version: 1 }))).toContain("<p>抽屉和整页</p>");
      expect(yield* Effect.promise(() => c.tool("artifact_get", { id: one!.id }))).toContain("照评论改");
      // A file outside, and a link inside that leads to it.
      writeFileSync(join(cwd, "..", "secret.html"), "<p>外面的</p>");
      symlinkSync(join(cwd, "..", "secret.html"), join(cwd, "out", "link.html"));
      for (const file of ["../secret.html", "/etc/hosts", "out", "out/link.html"])
        expect(yield* Effect.promise(() => c.tool("artifact_create", { title: "外面的", kind: "html", file }))).toContain("没成");
      expect(yield* Effect.promise(() => c.tool("artifact_create", { title: "两个都给", kind: "html", file: "out/two.html", content: "x" }))).toContain("没成");
      expect((yield* artifacts.list({ issue })).length).toBe(1);
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
        const args = name === "channel_message_send" || name === "memory_create" ? { text: "must not be posted" } : {};
        expect(yield* Effect.promise(() => c.tool(name, args))).toContain("没认出你是谁");
      }
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("lets a helper search and write only its own memory", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      const memory = yield* Memory;
      yield* hired(core, { id: sessionId("w1"), name: "一号", agent: "lab", project: "demo" });
      yield* memory.write({ agent: "scout", text: "这个项目测试用 make check", project: "demo", by: owner });
      const c = client(mcp, "w1");
      const tool = (name: string, args: Record<string, unknown>) => Effect.promise(() => c.tool(name, args));
      expect(yield* tool("memory_create", { text: "这个项目测试用 pnpm test" })).toContain("记下了（项目 demo）");
      expect(yield* tool("memory_create", { text: "提交信息写中文", project: "" })).toContain("记下了（所有项目）");
      // There is no profile to name: what it writes is its own, whatever it says.
      yield* tool("memory_create", { text: "冒名记一条", agent: "scout" });
      expect((yield* memory.list("scout")).some((m) => m.text === "冒名记一条")).toBe(false);
      // What it wrote is its own, not the owner's: the 记性 tab says which helper wrote it.
      for (const m of yield* memory.list("lab")) expect([m.author, m.session]).toEqual(["session", "w1"]);
      const found = yield* tool("memory_search", { text: "测试" });
      expect(found).toContain("pnpm test");
      expect(found).not.toContain("make check");
      expect(yield* tool("memory_search", { text: "部署" })).toContain("没有搜到「部署」");
      expect(yield* Effect.promise(() => client(mcp, "w9").tool("memory_search", { text: "测试" }))).toContain("你不在场");
    }).pipe(Effect.scoped, Effect.provide(world({ who: (token) => token }))),
  );

  // A helper writes a blocks artifact through its tools: the same ops as the owner's editor, written as its profile; a
  // stale rewrite over the owner's change is not taken and says what the block has now.
  it.live("lets a helper write in a blocks artifact", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      const artifacts = yield* Artifact;
      yield* hired(core, { id: sessionId("w1"), name: "一号", agent: "lab" });
      const d = yield* artifacts.create({ from: ownerId, by: ownerId }, { title: "周报" });
      const c = client(mcp, "w1");
      const tool = (name: string, args: Record<string, unknown>) => Effect.promise(() => c.tool(name, args));
      const added = yield* tool("artifact_block_create", { id: d.id, text: "这周做完了**第一步**" });
      const block = /加了一块〔(\S+)〕，第 (\d+) 版/u.exec(added)![1]!;
      expect(yield* tool("artifact_block_create", { id: d.id, text: "下周", type: "heading", level: 1 })).toContain("加了一块");
      expect(yield* tool("artifact_block_create", { id: d.id, text: "x", type: "table" })).toContain("没成：块的类型只能是");
      const read = yield* tool("artifact_content_get", { id: d.id });
      expect(read).toContain("《周报》，2 块");
      expect(read).toContain("〔" + block + " · 第 1 版 · paragraph〕这周做完了第一步");
      expect(yield* tool("artifact_block_update", { id: d.id, block, baseRev: 1, text: "这周做完了第一步和第二步" })).toContain("现在是第 2 版");
      // The owner changes it in the editor; the helper's next rewrite was made against rev 2.
      yield* artifacts.submit(d.id, "owner", {
        batchId: "owner",
        ops: [{ op: "update_text", blockId: block, baseRev: 2, text: [{ t: "主人改过的", marks: {} }] }],
      });
      const stale = yield* tool("artifact_block_update", { id: d.id, block, baseRev: 2, text: "帮工又改" });
      expect(stale).toContain("没改：这一块刚被别人改过，现在是第 3 版");
      expect(stale).toContain("主人改过的");
      const snap = yield* artifacts.blocks(d.id);
      expect([snap.blocks[0]!.text[0]!.t, snap.blocks[0]!.updatedBy, snap.blocks[1]!.updatedBy]).toEqual(["主人改过的", "owner", "lab"]);
      expect(yield* artifacts.markdown(d.id)).toBe("主人改过的\n\n# 下周\n");
      expect(yield* tool("artifact_content_get", { id: "nope" })).toContain("没成");
    }).pipe(Effect.scoped, Effect.provide(world({ who: (token) => token }))),
  );
});
