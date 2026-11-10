import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Formatter } from "effect";

import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { blockId, sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { Artifact } from "#/artifact/artifact.ts";
import { user } from "#/base/actor.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Issue } from "#/issue/issue.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Memory } from "#/memory/memory.ts";
import { Pkm } from "#/pkm/pkm.ts";
import { Session } from "#/session/session.ts";
import { starter, until, waitFor } from "#/testing/layers.ts";
import { Said, world } from "#/testing/world.ts";

import { Mcp } from "./mcp.ts";

const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

interface Answer {
  readonly result?: { readonly isError?: boolean; readonly content?: { readonly text: string }[]; readonly tools?: { readonly name: string }[] };
  readonly error?: unknown;
}

/** An MCP client of one token, straight at the handler, as a coding agent's would be over HTTP. */
const client = (mcp: Mcp["Service"], token: string) => {
  let id = 0;
  const post = async (body: unknown) => {
    const res = await Effect.runPromise(
      mcp.handle(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(token ? { authorization: "Bearer " + token } : {}),
          },
          body: Formatter.formatJson(body),
        }),
      ),
    );
    const raw = await res.text();
    return raw ? (JSON.parse(raw) as Answer) : {};
  };
  const call = (method: string, params: unknown) => post({ jsonrpc: "2.0", id: ++id, method, params });
  return {
    result: (name: string, args: Record<string, unknown> = {}) => call("tools/call", { name, arguments: args }),
    init: () => call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    list: async () => ((await call("tools/list", {})).result?.tools ?? []).map((t) => t.name),
    tool: async (name: string, args: Record<string, unknown> = {}) =>
      ((await call("tools/call", { name, arguments: args })).result?.content ?? []).map((c) => c.text).join(""),
  };
};

const hired = (core: Core["Service"], s: Partial<T.Session> & { id: string }) =>
  core.apply({
    type: "sessionChanged",
    session: {
      name: s.id,
      role: "worker",
      agent: "",
      runtime: "pi",
      brief: "",
      hiredAt: 0,
      runs: 0,
      phase: { _tag: "working", since: 0, doing: { action: "thinking", label: "" } },
      ...s,
      refining: false,
    },
  });

describe("mcp", () => {
  it.live("regression: a preflight identity can diagnose but cannot report or mutate", () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const c = client(mcp, "pending");
      expect((yield* Effect.promise(() => c.result("session_list"))).result?.isError).not.toBe(true);
      expect((yield* Effect.promise(() => c.result("issue_report", { summary: "not registered" }))).result?.isError).toBe(true);
      expect((yield* Effect.promise(() => c.result("channel_message_send", { text: "not registered" }))).result?.isError).toBe(true);
      expect((yield* Said).all()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world({ who: () => "pending" }))),
  );
  it.live("regression: rejected MCP calls expose machine-readable failure without executing business", () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      for (const token of ["", "invalid", "revoked"]) {
        const answer = yield* Effect.promise(() => client(mcp, token).result("issue_report", { summary: "forged" }));
        expect(answer.result?.isError).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(world())),
  );
  it.live("gives a session its tools, as itself", () => {
    const tokens: string[] = [];
    const proceed = Promise.withResolvers<void>();
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        expect(turn.options.env?.VIBEVALLEY_WORKER_TOKEN).toBeUndefined();
        await proceed.promise;
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
        "artifact_block_delete",
        "artifact_block_update",
        "artifact_content_get",
        "artifact_create",
        "artifact_get",
        "artifact_list",
        "artifact_version_create",
        "channel_message_list",
        "channel_message_send",
        "channel_unread_list",
        "issue_handback",
        "issue_pr_submit",
        "issue_report",
        "issue_split",
        "memory_create",
        "memory_search",
        "pkm_capture",
        "pkm_comment_suggest",
        "pkm_page_get",
        "pkm_search",
        "resource_read",
        "session_list",
      ]);
      const extra = (yield* chat.post({ _tag: "User", text: "顺手做另一件事", channel: thread, sendKey: "extra" })).message;
      const mailbox = yield* Mailbox;
      yield* waitFor(
        Effect.succeed(mailbox.deliveriesOf(id).find((row) => row.envelope_id === extra.id)?.channel_id),
        (channel) => channel === thread,
        "the mailbox handoff",
      );
      const tool2 = yield* Effect.promise(() => c.tool("issue_handback", { envelope: extra.id, reason: "不是当前工单" }));
      expect(tool2).toContain("重新分流");
      expect(mailbox.deliveriesOf(id).some((input) => input.envelope_id === extra.id)).toBe(false);
      expect((yield* Effect.promise(() => c.result("issue_pr_submit"))).result?.isError).toBe(true);
      const tool3 = yield* Effect.promise(() => c.tool("issue_pr_submit"));
      expect(tool3).toContain("没有用户明确授予");
      const tool4 = yield* Effect.promise(() =>
        c.tool("issue_report", { session: "another-session", summary: "需要端口", questions: [{ question: "端口用哪个？", options: ["8787", "8788"] }] }),
      );
      expect(tool4).toContain("报告已记录");
      proceed.resolve();
      const issue = got.session!.issue!;
      yield* waitFor(issues.get(issue), (item) => item.questions.length > 0, "the structured report");
      expect((yield* issues.get(issue)).questions).toEqual([{ question: "端口用哪个？", options: ["8787", "8788"] }]);
      const who = yield* Effect.promise(() => c.tool("session_list"));
      expect(who).toMatch(new RegExp(`^- ${id} `, "mu"));
      // Names are listed without an @: models copy a wake.
      expect(who.split("\n").slice(0, -1).join("\n")).not.toContain("@");
      const tool5 = yield* Effect.promise(() => c.tool("channel_message_send", { text: "从 MCP 说一句", anyway: true }));
      expect(tool5).toContain("发出去了");
      const m = saidIn(thread!).find((x) => x.text === "从 MCP 说一句");
      expect(m).toMatchObject({ from: id, fromKind: "agent", fromRole: "worker" });
      const tool6 = yield* Effect.promise(() => c.tool("channel_unread_list"));
      expect(tool6).not.toBe("");
      const tool7 = yield* Effect.promise(() => c.tool("channel_message_list"));
      expect(tool7).toContain("从 MCP 说一句");
      const tool8 = yield* Effect.promise(() => client(mcp, "").tool("session_list"));
      expect(tool8).toContain("没认出你是谁");
      const tool9 = yield* Effect.promise(() => client(mcp, "hb_w1_forged").tool("channel_message_send", { text: "冒名" }));
      expect(tool9).toContain("没认出你是谁");
      yield* (yield* Session).dismiss(id);
      expect((yield* Effect.promise(() => c.result("channel_message_send", { text: "revoked" }))).result?.isError).toBe(true);
      expect(saidIn(thread!).some((message) => ["revoked", "冒名"].includes(message.text))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [pi], repos: ["chat-j"] })));
  });

  it.live("lets a session find and read the user's notes, note a line in today's journal and propose a rewrite, never change a block", () => {
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
      const mcp = yield* Mcp;
      const pkm = yield* Pkm;
      yield* pkm.save({ title: "Beehives", tier: "project", markdown: "- check the queens every week\n- order frames\n" });
      yield* issues.hire(lab(), "看看蜂箱", "chat-j");
      yield* until(() => tokens.length > 0, "the session's token");
      const c = client(mcp, tokens[0]!);
      yield* Effect.promise(c.init);
      const found = yield* Effect.promise(() => c.tool("pkm_search", { text: "queens" }));
      expect(found).toContain("《Beehives》");
      const block = /〔([0-9a-f-]{36})〕/u.exec(found)?.[1] ?? "";
      const tool2 = yield* Effect.promise(() => c.tool("pkm_page_get", { page: "Beehives" }));
      expect(tool2).toContain(`〔${block}〕check the queens every week`);
      const tool3 = yield* Effect.promise(() => c.tool("pkm_capture", { text: "蜂箱要换新的框" }));
      expect(tool3).toContain("LATER");
      const journal = (yield* pkm.list()).pages.find((p) => p.tier === "journal")!;
      expect((yield* pkm.page(journal.slug)).page.blocks.map((b) => b.body).join("\n")).toMatch(/蜂箱要换新的框（.+ 记） #inbox/u);
      const tool4 = yield* Effect.promise(() => c.tool("pkm_comment_suggest", { block, suggested: "check the queens every Monday" }));
      expect(tool4).toContain("接受");
      expect((yield* pkm.page("beehives")).page.blocks[0]?.body).toBe("check the queens every week");
      expect((yield* pkm.comments("beehives")).map((x) => x.suggested)).toEqual(["check the queens every Monday"]);
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
      const cwd = sessions.cwdOf(id)!;
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
      const content2 = yield* artifacts.content(one!.id);
      expect(content2).toMatchObject({ content: "<p>抽屉和整页</p>" });
      const tool2 = yield* Effect.promise(() => c.tool("artifact_list"));
      expect(tool2).toContain(one!.id);
      const tool3 = yield* Effect.promise(() => c.tool("artifact_version_create", { id: one!.id, content: "<p>改了</p>", note: "照评论改" }));
      expect(tool3).toContain("第 2 稿");
      const refusedAnswer = yield* Effect.promise(() =>
        c.tool("artifact_version_create", { id: one!.id, content: '<p>x</p>\n<script src="https://unpkg.com/react"></script>' }),
      );
      expect([refusedAnswer.includes("没成"), refusedAnswer.includes("unpkg.com")]).toEqual([true, true]);
      const tool4 = yield* Effect.promise(() => c.tool("artifact_version_create", { id: one!.id, content: "<script>fetch('/x')</script>" }));
      expect(tool4).toContain("fetch");
      const tool5 = yield* Effect.promise(() => c.tool("artifact_content_get", { id: one!.id, version: 1 }));
      expect(tool5).toContain("<p>抽屉和整页</p>");
      const tool6 = yield* Effect.promise(() => c.tool("artifact_get", { id: one!.id }));
      expect(tool6).toContain("照评论改");
      // A file outside, and a link inside that leads to it.
      writeFileSync(join(cwd, "..", "secret.html"), "<p>外面的</p>");
      symlinkSync(join(cwd, "..", "secret.html"), join(cwd, "out", "link.html"));
      for (const file of ["../secret.html", "/etc/hosts", "out", "out/link.html"]) {
        const reply = yield* Effect.promise(() => c.tool("artifact_create", { title: "外面的", kind: "html", file }));
        expect(reply).toContain("没成");
      }
      const tool7 = yield* Effect.promise(() => c.tool("artifact_create", { title: "两个都给", kind: "html", file: "out/two.html", content: "x" }));
      expect(tool7).toContain("没成");
      expect((yield* artifacts.list({ issue })).length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [pi], repos: ["chat-j"] })));
  });

  it.live("regression: a channel context lists and creates artifacts only in its own channel", () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        turn.say("在呢");
      },
    });
    return Effect.gen(function* () {
      const agents = yield* Agent;
      const artifacts = yield* Artifact;
      const chat = yield* Channel;
      const mcp = yield* Mcp;
      yield* agents.save(lab());
      const outside = yield* artifacts.create(
        { from: userId, by: userId },
        {
          title: "别处的稿子",
          kind: "html",
          content: "outside",
          channel: chat.defaultChannel(),
        },
      );
      const direct = yield* chat.direct("lab");
      yield* chat.post({ _tag: "User", text: "在这里做一份", channel: direct, sendKey: "" });
      yield* until(() => tokens.length > 0, "the channel context's token");
      const c = client(mcp, tokens[0]!);
      yield* Effect.promise(c.init);
      const tool2 = yield* Effect.promise(() => c.tool("artifact_create", { title: "这里的稿子", kind: "html", content: "inside" }));
      expect(tool2).toContain("做好了");
      const [inside] = yield* artifacts.list({ channel: direct });
      expect(inside).toMatchObject({ title: "这里的稿子", channel: direct, by: "lab" });
      const listed = yield* Effect.promise(() => c.tool("artifact_list"));
      expect(listed).toContain(inside!.id);
      expect(listed).not.toContain(outside.id);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [pi] })));
  });

  it.live("lists sessions by their phase", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      yield* hired(core, { id: sessionId("failed"), name: "失败的", phase: { _tag: "failed" } });
      yield* hired(core, { id: sessionId("resting"), name: "歇着的", phase: { _tag: "resting" } });
      yield* hired(core, { id: sessionId("done"), name: "交活的", phase: { _tag: "done" } });
      const text = yield* Effect.promise(() => client(mcp, "token").tool("session_list"));
      for (const want of ["这一轮没做成", "歇着（上一轮没做完）", "交活的"]) expect(text).toContain(want);
    }).pipe(Effect.scoped, Effect.provide(world({ who: () => "caller" }))),
  );

  it.live("calls no tool for a caller it does not know", () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const c = client(mcp, "");
      for (const name of yield* Effect.promise(c.list)) {
        const args = name === "channel_message_send" || name === "memory_create" ? { text: "must not be posted" } : {};
        const tool2 = yield* Effect.promise(() => c.tool(name, args));
        expect(tool2).toContain("没认出你是谁");
      }
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("lets a helper search and write only its own memory", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      const memory = yield* Memory;
      yield* hired(core, { id: sessionId("w1"), name: "一号", agent: "lab", repo: "demo" });
      yield* memory.write({ agent: "scout", text: "这个仓库测试用 make check", repo: "demo", by: user });
      const c = client(mcp, "w1");
      const tool = (name: string, args: Record<string, unknown>) => Effect.promise(() => c.tool(name, args));
      const tool2 = yield* tool("memory_create", { text: "这个仓库测试用 pnpm test" });
      expect(tool2).toContain("记下了（仓库 demo）");
      const tool3 = yield* tool("memory_create", { text: "提交信息写中文", repo: "" });
      expect(tool3).toContain("记下了（所有仓库）");
      // There is no profile to name: what it writes is its own, whatever it says.
      yield* tool("memory_create", { text: "冒名记一条", agent: "scout" });
      expect((yield* memory.list("scout")).some((m) => m.text === "冒名记一条")).toBe(false);
      // What it wrote is its own, not the user's: the Memory tab says which helper wrote it.
      for (const m of yield* memory.list("lab")) expect([m.author, m.session]).toEqual(["agent", "w1"]);
      const found = yield* tool("memory_search", { text: "测试" });
      expect(found).toContain("pnpm test");
      expect(found).not.toContain("make check");
      const tool4 = yield* tool("memory_search", { text: "部署" });
      expect(tool4).toContain("没有搜到「部署」");
      expect((yield* Effect.promise(() => client(mcp, "w9").result("memory_search", { text: "测试" }))).result?.isError).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world({ who: (token) => token }))),
  );

  // A helper writes a blocks artifact through its tools: the same ops as the user's editor, written as its profile.
  it.live("lets a helper write in a blocks artifact", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const mcp = yield* Mcp;
      const artifacts = yield* Artifact;
      yield* hired(core, { id: sessionId("w1"), name: "一号", agent: "lab" });
      const d = yield* artifacts.create({ from: userId, by: userId }, { title: "周报", kind: "markdown" });
      const c = client(mcp, "w1");
      const tool = (name: string, args: Record<string, unknown>) => Effect.promise(() => c.tool(name, args));
      const added = yield* tool("artifact_block_create", { id: d.id, text: "这周做完了**第一步**" });
      const block = /加了一块〔(\S+)〕，第 (\d+) 版/u.exec(added)![1]!;
      const tool2 = yield* tool("artifact_block_create", { id: d.id, text: "下周", type: "heading", level: 1 });
      expect(tool2).toContain("加了一块");
      const tool3 = yield* tool("artifact_block_create", { id: d.id, text: "x", type: "table" });
      expect(tool3).toContain("没成：块的类型只能是");
      const read = yield* tool("artifact_content_get", { id: d.id });
      expect(read).toContain("《周报》，2 块");
      expect(read).toContain("〔" + block + " · 第 1 版 · paragraph〕这周做完了第一步");
      const tool4 = yield* tool("artifact_block_update", { id: d.id, block, baseRev: 1, text: "这周做完了第一步和第二步" });
      expect(tool4).toContain("现在是第 2 版");
      // The user changes it in the editor; the helper's next rewrite was made against rev 2.
      yield* artifacts.submit(d.id, "user", {
        batchId: "user",
        ops: [{ op: "update_text", blockId: blockId(block), baseRev: 2, text: [{ t: "用户改过的", marks: {} }] }],
      });
      const suggested = yield* tool("artifact_block_update", { id: d.id, block, baseRev: 3, text: "帮工建议的字" });
      expect(suggested).toContain("提了建议");
      const open = (yield* artifacts.suggestions(d.id)).filter((s) => s.status === "open");
      expect(open.map((s) => [s.blockId, s.baseRev, s.author])).toEqual([[block, 3, "lab"]]);
      yield* artifacts.acceptSuggestion(d.id, open[0]!.id, "user");
      const snap = yield* artifacts.blocks(d.id);
      expect([snap.blocks[0]!.text[0]!.t, snap.blocks[0]!.updatedBy, snap.blocks[1]!.updatedBy]).toEqual(["帮工建议的字", "user", "lab"]);
      const markdown2 = yield* artifacts.markdown(d.id);
      expect(markdown2).toBe("帮工建议的字\n\n# 下周\n");
      const tool5 = yield* tool("artifact_content_get", { id: "nope" });
      expect(tool5).toContain("没成");
    }).pipe(Effect.scoped, Effect.provide(world({ who: (token) => token }))),
  );
});
