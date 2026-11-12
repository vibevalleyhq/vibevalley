import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { blockId, sessionId } from "@vibevalley/protocol/schema";

import { user } from "#/base/actor.ts";
import type { Core } from "#/core/core.ts";
import { starter, until, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import type { Mcp } from "./mcp.ts";

const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

interface Answer {
  readonly result?: { readonly isError?: boolean; readonly content?: { readonly text: string }[]; readonly tools?: { readonly name: string }[] };
  readonly error?: unknown;
}

/** An MCP client of one token, straight at the handler, as a coding agent's would be over HTTP. */
const client = (mcp: Mcp, token: string) => {
  let id = 0;
  const post = async (body: unknown) => {
    const res = await mcp.handle(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
      }),
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

const hired = (core: Core, s: Partial<T.Session> & { id: string }) =>
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
  test("regression: a preflight identity can diagnose but cannot report or mutate", async () => {
    await using farm = await world({ who: () => "pending" });
    const mcp = farm.mcp;
    const c = client(mcp, "pending");
    expect((await c.result("session_list")).result?.isError).not.toBe(true);
    expect((await c.result("issue_report", { summary: "not registered" })).result?.isError).toBe(true);
    expect((await c.result("channel_message_send", { text: "not registered" })).result?.isError).toBe(true);
    expect(farm.said.all()).toEqual([]);
  });
  test("regression: rejected MCP calls expose machine-readable failure without executing business", async () => {
    await using farm = await world();
    const mcp = farm.mcp;
    for (const token of ["", "invalid", "revoked"]) {
      const answer = await client(mcp, token).result("issue_report", { summary: "forged" });
      expect(answer.result?.isError).toBe(true);
    }
  });
  test("gives a session its tools, as itself", async () => {
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
    await using farm = await world({ runtimes: [pi], repos: ["chat-j"] });
    const issues = farm.issue;
    const { in: saidIn } = farm.said;
    const chat = farm.channel;
    const mcp = farm.mcp;
    const got = await issues.hire(lab(), "写 hello", "chat-j");
    const id = got.session.id;
    await until(() => tokens.length > 0, "the session's token");
    const thread = await waitFor(
      () => chat.homeOf(id),
      (t) => t !== undefined,
      "the session's thread",
    );
    const c = client(mcp, tokens[0]!);
    await c.init();
    expect((await c.list()).toSorted()).toEqual([
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
      "library_item_add",
      "library_item_list",
      "memory_create",
      "memory_search",
      "pkm_capture",
      "pkm_comment_suggest",
      "pkm_page_get",
      "pkm_search",
      "resource_read",
      "session_list",
    ]);
    const extra = (await chat.say({ text: "顺手做另一件事", channel: thread, sendKey: "extra" })).message;
    const mailbox = farm.inside;
    await waitFor(
      () => mailbox.deliveriesOf(id).find((row) => row.envelope_id === extra.id)?.channel_id,
      (channel) => channel === thread,
      "the mailbox handoff",
    );
    const tool2 = await c.tool("issue_handback", { envelope: extra.id, reason: "不是当前工单" });
    expect(tool2).toContain("重新分流");
    expect(mailbox.deliveriesOf(id).some((input) => input.envelope_id === extra.id)).toBe(false);
    expect((await c.result("issue_pr_submit")).result?.isError).toBe(true);
    const tool3 = await c.tool("issue_pr_submit");
    expect(tool3).toContain("没有用户明确授予");
    const tool4 = await c.tool("issue_report", {
      session: "another-session",
      summary: "需要端口",
      questions: [{ question: "端口用哪个？", options: ["8787", "8788"] }],
    });
    expect(tool4).toContain("报告已记录");
    proceed.resolve();
    const issue = got.session.issue!;
    await waitFor(
      () => issues.get(issue),
      (item) => item.questions.length > 0,
      "the structured report",
    );
    expect((await issues.get(issue)).questions).toEqual([{ question: "端口用哪个？", options: ["8787", "8788"] }]);
    const who = await c.tool("session_list");
    expect(who).toMatch(new RegExp(`^- ${id} `, "mu"));
    // Names are listed without an @: models copy a wake.
    expect(who.split("\n").slice(0, -1).join("\n")).not.toContain("@");
    const tool5 = await c.tool("channel_message_send", { text: "从 MCP 说一句", anyway: true });
    expect(tool5).toContain("发出去了");
    const m = saidIn(thread!).find((x) => x.text === "从 MCP 说一句");
    expect(m).toMatchObject({ from: id, actor: { kind: "agent", id, role: "worker" } });
    const tool6 = await c.tool("channel_unread_list");
    expect(tool6).not.toBe("");
    const tool7 = await c.tool("channel_message_list");
    expect(tool7).toContain("从 MCP 说一句");
    const tool8 = await client(mcp, "").tool("session_list");
    expect(tool8).toContain("没认出你是谁");
    const tool9 = await client(mcp, "hb_w1_forged").tool("channel_message_send", { text: "冒名" });
    expect(tool9).toContain("没认出你是谁");
    await farm.inside.dismiss(id);
    expect((await c.result("channel_message_send", { text: "revoked" })).result?.isError).toBe(true);
    expect(saidIn(thread!).some((message) => ["revoked", "冒名"].includes(message.text))).toBe(false);
  });

  test("lets a session find and read the user's notes, note a line in today's journal and propose a rewrite, never change a block", async () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        turn.say("做完了");
      },
    });
    await using farm = await world({ runtimes: [pi], repos: ["chat-j"] });
    const issues = farm.issue;
    const mcp = farm.mcp;
    const pkm = farm.pkm;
    await pkm.save({ title: "Beehives", tier: "project", markdown: "- check the queens every week\n- order frames\n" });
    await issues.hire(lab(), "看看蜂箱", "chat-j");
    await until(() => tokens.length > 0, "the session's token");
    const c = client(mcp, tokens[0]!);
    await c.init();
    const found = await c.tool("pkm_search", { text: "queens" });
    expect(found).toContain("《Beehives》");
    const block = /〔([0-9a-f-]{36})〕/u.exec(found)?.[1] ?? "";
    const tool2 = await c.tool("pkm_page_get", { page: "Beehives" });
    expect(tool2).toContain(`〔${block}〕check the queens every week`);
    const tool3 = await c.tool("pkm_capture", { text: "蜂箱要换新的框" });
    expect(tool3).toContain("LATER");
    const journal = (await pkm.list()).pages.find((p) => p.tier === "journal")!;
    expect((await pkm.page(journal.slug)).page.blocks.map((b) => b.body).join("\n")).toMatch(/蜂箱要换新的框（.+ 记） #inbox/u);
    const tool4 = await c.tool("pkm_comment_suggest", { block, suggested: "check the queens every Monday" });
    expect(tool4).toContain("接受");
    expect((await pkm.page("beehives")).page.blocks[0]?.body).toBe("check the queens every week");
    expect((await pkm.comments("beehives")).map((x) => x.suggested)).toEqual(["check the queens every Monday"]);
  });

  test("lets a session hand in a file of its working directory as an artifact for its issue, and nothing outside it", async () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        turn.say("做完了");
      },
    });
    await using farm = await world({ runtimes: [pi], repos: ["chat-j"] });
    const issues = farm.issue;
    const chat = farm.channel;
    const mcp = farm.mcp;
    const sessions = farm.inside;
    const artifacts = farm.artifact;
    const media = farm.media;
    const got = await issues.hire(lab(), "画两种详情", "chat-j");
    const id = got.session.id;
    await until(() => tokens.length > 0, "the session's token");
    const thread = await waitFor(
      () => chat.homeOf(id),
      (t) => t !== undefined,
      "the session's thread",
    );
    const cwd = sessions.live(id).cwd!;
    mkdirSync(join(cwd, "out"), { recursive: true });
    writeFileSync(join(cwd, "out", "two.html"), "<p>抽屉和整页</p>");
    const c = client(mcp, tokens[0]!);
    await c.init();
    const made = await c.tool("artifact_create", { title: "两种详情", kind: "html", file: "out/two.html", note: "抽屉和整页" });
    expect(made).toContain("做好了");
    const issue = sessions.live(id).session!.issue!;
    const [one] = await artifacts.list({ issue });
    expect(one).toMatchObject({ title: "两种详情", channel: thread, by: "lab", version: 1 });
    expect((await chat.history(thread!)).at(-1)!.artifact).toMatchObject({ id: one!.id, version: 1 });
    const content2 = await artifacts.content(one!.id);
    expect(content2).toMatchObject({ content: "<p>抽屉和整页</p>" });
    const tool2 = await c.tool("artifact_list");
    expect(tool2).toContain(one!.id);
    const tool3 = await c.tool("artifact_version_create", { id: one!.id, content: "<p>改了</p>", note: "照评论改" });
    expect(tool3).toContain("第 2 稿");
    const refusedAnswer = await c.tool("artifact_version_create", { id: one!.id, content: '<p>x</p>\n<script src="https://unpkg.com/react"></script>' });
    expect([refusedAnswer.includes("没成"), refusedAnswer.includes("unpkg.com")]).toEqual([true, true]);
    const tool4 = await c.tool("artifact_version_create", { id: one!.id, content: "<script>fetch('/x')</script>" });
    expect(tool4).toContain("fetch");
    const tool5 = await c.tool("artifact_content_get", { id: one!.id, version: 1 });
    expect(tool5).toContain("<p>抽屉和整页</p>");
    const tool6 = await c.tool("artifact_get", { id: one!.id });
    expect(tool6).toContain("照评论改");
    // A file outside, and a link inside that leads to it.
    writeFileSync(join(cwd, "..", "secret.html"), "<p>外面的</p>");
    symlinkSync(join(cwd, "..", "secret.html"), join(cwd, "out", "link.html"));
    for (const file of ["../secret.html", "/etc/hosts", "out", "out/link.html"]) {
      const reply = await c.tool("artifact_create", { title: "外面的", kind: "html", file });
      expect(reply).toContain("没成");
    }
    const tool7 = await c.tool("artifact_create", { title: "两个都给", kind: "html", file: "out/two.html", content: "x" });
    expect(tool7).toContain("没成");
    expect((await artifacts.list({ issue })).length).toBe(1);
    // The library reads the same working directory, by the same rule.
    const kept = await c.tool("library_item_add", { path: "out/two.html", name: "两种详情.html" });
    expect(kept).toContain("两种详情.html");
    for (const path of ["../secret.html", "out/link.html"]) {
      const reply = await c.tool("library_item_add", { path });
      expect(reply).toContain("没成");
    }
    const fetched = await media.libraryItems({ origin: "fetched" });
    expect(fetched).toEqual([expect.objectContaining({ origin: { kind: "fetched", agent: "lab", session: id, from: { path: "out/two.html" } } })]);
  });

  test("regression: a channel context lists and creates artifacts only in its own channel", async () => {
    const tokens: string[] = [];
    const pi = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? [])
          if (s.name === "vibevalley" && "headers" in s) tokens.push((s.headers.authorization ?? "").replace(/^Bearer /u, ""));
        turn.say("在呢");
      },
    });
    await using farm = await world({ runtimes: [pi] });
    const agents = farm.agent;
    const artifacts = farm.artifact;
    const chat = farm.channel;
    const mcp = farm.mcp;
    await agents.save(lab());
    const outside = await artifacts.create(
      { from: userId, by: userId },
      {
        title: "别处的 Artifact",
        kind: "html",
        content: "outside",
        channel: chat.defaultChannel(),
      },
    );
    const direct = await farm.watch.direct("lab");
    await chat.say({ text: "在这里做一份", channel: direct, sendKey: "" });
    await until(() => tokens.length > 0, "the channel context's token");
    const c = client(mcp, tokens[0]!);
    await c.init();
    const tool2 = await c.tool("artifact_create", { title: "这里的 Artifact", kind: "html", content: "inside" });
    expect(tool2).toContain("做好了");
    const [inside] = await artifacts.list({ channel: direct });
    expect(inside).toMatchObject({ title: "这里的 Artifact", channel: direct, by: "lab" });
    const listed = await c.tool("artifact_list");
    expect(listed).toContain(inside!.id);
    expect(listed).not.toContain(outside.id);
  });

  test("lists sessions by their phase", async () => {
    await using farm = await world({ who: () => "caller" });
    const core = farm.core;
    const mcp = farm.mcp;
    hired(core, { id: sessionId("failed"), name: "失败的", phase: { _tag: "failed" } });
    hired(core, { id: sessionId("resting"), name: "歇着的", phase: { _tag: "resting" } });
    hired(core, { id: sessionId("done"), name: "交活的", phase: { _tag: "done" } });
    const text = await client(mcp, "token").tool("session_list");
    for (const want of ["这一轮没做成", "歇着的", "交活的"]) expect(text).toContain(want);
    // A session that has not finished a run yet rests; it did not break one off.
    expect(text).not.toContain("没做完");
  });

  test("calls no tool for a caller it does not know", async () => {
    await using farm = await world();
    const mcp = farm.mcp;
    const c = client(mcp, "");
    for (const name of await c.list()) {
      const args = name === "channel_message_send" || name === "memory_create" ? { text: "must not be posted" } : {};
      const tool2 = await c.tool(name, args);
      expect(tool2).toContain("没认出你是谁");
    }
  });

  test("lets a helper search and write only its own memory", async () => {
    await using farm = await world({ who: (token) => token });
    const core = farm.core;
    const mcp = farm.mcp;
    const memory = farm.memory;
    hired(core, { id: sessionId("w1"), name: "一号", agent: "lab", repo: "demo" });
    await memory.write({ agent: "scout", text: "这个仓库测试用 make check", repo: "demo", by: user });
    const c = client(mcp, "w1");
    const tool = (name: string, args: Record<string, unknown>) => c.tool(name, args);
    const tool2 = await tool("memory_create", { text: "这个仓库测试用 pnpm test" });
    expect(tool2).toContain("记下了（仓库 demo）");
    const tool3 = await tool("memory_create", { text: "提交信息写中文", repo: "" });
    expect(tool3).toContain("记下了（所有仓库）");
    // There is no profile to name: what it writes is its own, whatever it says.
    await tool("memory_create", { text: "冒名记一条", agent: "scout" });
    expect((await memory.list("scout")).some((m) => m.text === "冒名记一条")).toBe(false);
    // What it wrote is its own, not the user's: the Memory tab says which helper wrote it.
    for (const m of await memory.list("lab")) expect([m.author, m.session]).toEqual(["agent", "w1"]);
    const found = await tool("memory_search", { text: "测试" });
    expect(found).toContain("pnpm test");
    expect(found).not.toContain("make check");
    const tool4 = await tool("memory_search", { text: "部署" });
    expect(tool4).toContain("没有搜到「部署」");
    expect((await client(mcp, "w9").result("memory_search", { text: "测试" })).result?.isError).toBe(true);
  });

  // A helper writes a blocks artifact through its tools: the same ops as the user's editor, written as its profile.
  test("lets a helper write in a blocks artifact", async () => {
    await using farm = await world({ who: (token) => token });
    const core = farm.core;
    const mcp = farm.mcp;
    const artifacts = farm.artifact;
    hired(core, { id: sessionId("w1"), name: "一号", agent: "lab" });
    const d = await artifacts.create({ from: userId, by: userId }, { title: "周报", kind: "markdown" });
    const c = client(mcp, "w1");
    const tool = (name: string, args: Record<string, unknown>) => c.tool(name, args);
    const added = await tool("artifact_block_create", { id: d.id, text: "这周做完了**第一步**" });
    const block = /加了一块〔(\S+)〕，第 (\d+) 版/u.exec(added)![1]!;
    const tool2 = await tool("artifact_block_create", { id: d.id, text: "下周", type: "heading", level: 1 });
    expect(tool2).toContain("加了一块");
    const tool3 = await tool("artifact_block_create", { id: d.id, text: "x", type: "table" });
    expect(tool3).toContain("没成：块的类型只能是");
    const read = await tool("artifact_content_get", { id: d.id });
    expect(read).toContain("《周报》，2 块");
    expect(read).toContain("〔" + block + " · 第 1 版 · paragraph〕这周做完了第一步");
    const tool4 = await tool("artifact_block_update", { id: d.id, block, baseRev: 1, text: "这周做完了第一步和第二步" });
    expect(tool4).toContain("现在是第 2 版");
    // The user changes it in the editor; the helper's next rewrite was made against rev 2.
    await artifacts.submit(d.id, "user", {
      batchId: "user",
      ops: [{ op: "update_text", blockId: blockId(block), baseRev: 2, text: [{ t: "用户改过的", marks: {} }] }],
    });
    const suggested = await tool("artifact_block_update", { id: d.id, block, baseRev: 3, text: "帮工建议的字" });
    expect(suggested).toContain("提了建议");
    const open = (await artifacts.suggestions(d.id)).filter((s) => s.status === "open");
    expect(open.map((s) => [s.blockId, s.baseRev, s.author])).toEqual([[block, 3, "lab"]]);
    await artifacts.acceptSuggestion(d.id, open[0]!.id, "user");
    const snap = await artifacts.blocks(d.id);
    expect([snap.blocks[0]!.text[0]!.t, snap.blocks[0]!.updatedBy, snap.blocks[1]!.updatedBy]).toEqual(["帮工建议的字", "user", "lab"]);
    const markdown2 = await artifacts.markdown(d.id);
    expect(markdown2).toBe("帮工建议的字\n\n# 下周\n");
    const tool5 = await tool("artifact_content_get", { id: "nope" });
    expect(tool5).toContain("没成");
  });
});
