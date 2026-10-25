import type { Event, Session } from "@botiverse/oar";
import { fauxAssistantMessage, type FauxResponseStep, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { helperInstructions, vibevalleyRuntimeOf } from "./runtime.ts";
import { fauxLLM, lastUser, type Request, systemPrompt, tempHome, toolsOf, until } from "./testing.ts";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
const sessions: Session[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  for (const done of homes.splice(0)) done();
});

interface Opened {
  readonly session: Session;
  readonly events: Event[];
  readonly requests: Request[];
  readonly pending: () => number;
  readonly cwd: string;
  readonly home: string;
}

async function open(steps: FauxResponseStep[], extra: { resume?: string; home?: string; cwd?: string; mcp?: string; append?: string } = {}): Promise<Opened> {
  const { faux, llm, requests } = fauxLLM({ tokensPerSecond: 2_000 });
  faux.appendResponses(steps);
  const h = extra.home ?? home();
  const cwd = extra.cwd ?? home();
  const runtime = vibevalleyRuntimeOf({ home: () => h, llm: () => llm });
  const session = await runtime.session(
    { via: "bundled" },
    {
      cwd,
      ...(extra.resume ? { resume: extra.resume } : {}),
      ...(extra.append ? { appendSystemPrompt: extra.append } : {}),
      ...(extra.mcp ? { mcpServers: [{ name: "farm", command: process.execPath, args: [extra.mcp] }] } : {}),
    },
  );
  sessions.push(session);
  const events: Event[] = [];
  session.events((e) => events.push(e), { cursor: { sessionId: session.id, afterSeq: -1 } });
  return { session, events, requests, pending: () => faux.getPendingResponseCount(), cwd, home: h };
}

const ended = (r: Opened) => r.events.flatMap((e) => (e.kind === "turn_ended" ? [e.outcome] : []));
const text = (r: Opened) => r.events.flatMap((e) => (e.kind === "text_delta" ? [e.text] : [])).join("");
const toolStarted = (r: Opened) => r.events.some((e) => e.kind === "tool_call_started");

describe("VibeValley's runtime", () => {
  it("runs a prompt's tools and ends the turn completed", async () => {
    const r = await open(
      [fauxAssistantMessage([fauxText("我来写"), fauxToolCall("write_file", { path: "hello.txt", content: "hi" })]), fauxAssistantMessage("写好了 hello.txt")],
      { append: "你是后端老周。" },
    );
    expect((await r.session.prompt("写个 hello.txt")).kind).toBe("accepted");
    await until(() => ended(r).length === 1);
    expect(readFileSync(join(r.cwd, "hello.txt"), "utf8")).toBe("hi");
    const kinds = new Set(r.events.map((e) => e.kind));
    for (const k of ["model", "text_delta", "tool_call_started", "tool_call_ended", "turn_ended", "usage"]) expect(kinds).toContain(k);
    const started = r.events.find((e) => e.kind === "tool_call_started");
    expect(started).toMatchObject({
      tool: "write_file",
      input: `{"path":"hello.txt","content":"hi"}`,
    });
    expect(r.events.find((e) => e.kind === "tool_call_ended")).toMatchObject({ result: "ok" });
    expect(ended(r)[0]!.kind).toBe("completed");
    expect(text(r)).toBe("我来写写好了 hello.txt");
    const prompt = systemPrompt(r.requests[0]!);
    expect(prompt.startsWith(helperInstructions)).toBe(true);
    expect(prompt).toContain("你是后端老周。");
  });

  it("joins a steer, waits a queued input and drops a withdrawn one", async () => {
    const r = await open([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" })]),
      (c) => fauxAssistantMessage("听到：" + lastUser(c as unknown as Request)),
      (c) => fauxAssistantMessage("排到了：" + lastUser(c as unknown as Request)),
    ]);
    await r.session.prompt("开始");
    await until(() => toolStarted(r));
    expect((await r.session.prompt("又一个")).kind).toBe("rejected");
    expect((await r.session.steer!("顺便")).kind).toBe("accepted");
    await r.session.queue("然后");
    const drop = randomUUID();
    await r.session.queue("不要了", { inputId: drop });
    expect((await r.session.withdraw!(drop)).kind).toBe("accepted");
    await until(() => ended(r).length === 2);
    expect(text(r)).toBe("听到：顺便排到了：然后");
    expect(r.pending()).toBe(0);
  });

  it("ends the turn aborted", async () => {
    const r = await open([fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })])]);
    await r.session.prompt("睡");
    await until(() => toolStarted(r));
    expect((await r.session.abort()).kind).toBe("accepted");
    await until(() => ended(r).length === 1);
    expect(ended(r)[0]!.kind).toBe("aborted");
    expect((await r.session.abort()).kind).toBe("rejected");
  });

  it("goes on with a resumed session", async () => {
    const count = (c: unknown) => fauxAssistantMessage(`第 ${(c as Request).messages.filter((m) => m.role === "user").length} 句`);
    const first = await open([count]);
    await first.session.prompt("一");
    await until(() => ended(first).length === 1);
    await first.session.dispose();
    const again = await open([count], {
      resume: first.session.id,
      home: first.home,
      cwd: first.cwd,
    });
    expect(again.session.id).toBe(first.session.id);
    await again.session.prompt("二");
    await until(() => ended(again).length === 1);
    expect(text(again)).toBe("第 2 句");
  });

  it("gives the model the tools of the session's MCP servers", async () => {
    const dir = home();
    writeFileSync(
      join(dir, "farm.cjs"),
      `const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'farm', version: '1' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'say', description: '在田头说话', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '说了：' + m.params.arguments.text }] } })
})`,
    );
    const r = await open(
      [
        fauxAssistantMessage([fauxToolCall("farm__say", { text: "做完了" })]),
        (c) => fauxAssistantMessage((c as unknown as Request).messages.at(-1)?.role === "toolResult" ? "好" : "没调到"),
      ],
      { mcp: join(dir, "farm.cjs") },
    );
    await r.session.prompt("汇报");
    await until(() => ended(r).length === 1);
    expect(toolsOf(r.requests[0]!).map((t) => t.name)).toContain("farm__say");
    expect(r.events.find((e) => e.kind === "tool_call_ended")).toMatchObject({
      content: [{ type: "text", text: "说了：做完了" }],
    });
  });

  it("fails the turn when the model fails", async () => {
    const r = await open([fauxAssistantMessage("", { stopReason: "error", errorMessage: "DeepSeek 回了 503" })]);
    await r.session.prompt("试试");
    await until(() => ended(r).length === 1);
    expect(ended(r)[0]).toMatchObject({ kind: "failed", reason: "DeepSeek 回了 503" });
  });

  it("lists DeepSeek's models, is bundled, and says why it cannot run", async () => {
    const { llm } = fauxLLM();
    const runtime = vibevalleyRuntimeOf({ llm: () => llm });
    const models = await runtime.listModels();
    expect(models.kind === "ok" && models.models.some((m) => m.id === "deepseek-flash" && m.effortLevels?.join(",") === "high,max" && m.default)).toBe(true);
    expect(await runtime.installation!()).toEqual({ kind: "available", via: "bundled" });
    await expect(runtime.session({ via: "bundled" }, { cwd: tmpdir(), effort: "low" })).rejects.toThrow(/只有 high、max/);
    const keyless = vibevalleyRuntimeOf({
      llm: () => {
        throw new Error("没有 DeepSeek 的密钥");
      },
    });
    expect(await keyless.installation!()).toEqual({
      kind: "unsupported",
      reason: "没有 DeepSeek 的密钥",
    });
  });
});
