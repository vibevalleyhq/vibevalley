import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event, Session } from "@botiverse/oar";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { TaskGroup } from "@vibevalley/async";
import { tempDir } from "@vibevalley/testkit/temp";
import { whenTrue } from "@vibevalley/testkit/until";

import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { noDeepSeekKey } from "#/modules/agent/profile.ts";
import { type ScriptedDeepSeek, scriptedDeepSeek } from "#/testing/deepseek.ts";
import { answer, lastUser, type Request, scriptedLLM, type ScriptedModel, type Step, systemPrompt, text as words, toolCall, toolsOf } from "#/testing/model.ts";

import { type Durable, openDurable } from "./durable.ts";
import { type Helpers, makeHelpers } from "./helperExtension.ts";
import { durableWords } from "./prompts.ts";
import { helperInstructions, vibevalleyRuntimeOf } from "./vibevalley.ts";

const homes: (() => void)[] = [];
const home = () => {
  const dir = tempDir("vibevalley-agent-");
  homes.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sessions: Session[] = [];
const owners: TaskGroup[] = [];
const owner = () => {
  const tasks = new TaskGroup({ name: "test sessions" });
  owners.push(tasks);
  return tasks;
};
const log = keptLog();
const durables: Durable[] = [];
/** The scripted DeepSeek each harness asks. */
const seats = new Map<Durable, ScriptedDeepSeek>();
/** The helpers' side each harness opened with. */
const sides = new Map<Durable, Helpers>();
/** A harness kept in memory, or in file, with the helpers' extension, asking a scripted DeepSeek with nothing seated yet. */
const durable = async (file?: string) => {
  const seat = scriptedDeepSeek(wallTime);
  const helpers = makeHelpers({ time: wallTime, log });
  const d = await openDurable({ file, clock: wallTime, log, models: seat.models, extensions: [helpers.extension] });
  durables.push(d);
  seats.set(d, seat);
  sides.set(d, helpers);
  return d;
};
/** VibeValley's runtime on d. */
const runtimeOn = (d: Durable, owner: TaskGroup) => {
  const helpers = sides.get(d);
  if (!helpers) throw new Error("a harness this file did not open");
  return vibevalleyRuntimeOf({ durable: d, helpers, owner, log });
};
/** From now on, d's conversations are answered by llm. */
const seat = (d: Durable, llm: ScriptedModel) => {
  const found = seats.get(d);
  if (!found) throw new Error("a harness this file did not open");
  found.use(llm);
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  await Promise.all(owners.splice(0).map((tasks) => tasks.close()));
  await Promise.all(durables.splice(0).map((d) => d.close()));
  await Promise.all([...seats.values()].map((s) => s.close()));
  seats.clear();
  sides.clear();
  for (const done of homes.splice(0)) done();
});

interface Opened {
  readonly session: Session;
  readonly events: Event[];
  readonly requests: Request[];
  readonly pending: () => number;
  readonly cwd: string;
  readonly durable: Durable;
}

async function open(
  steps: readonly Step[],
  extra: { resume?: string; durable?: Durable; cwd?: string; mcp?: string; append?: string; env?: Record<string, string | null> } = {},
): Promise<Opened> {
  const { llm, requests, pending } = scriptedLLM(steps);
  const d = extra.durable ?? (await durable());
  seat(d, llm);
  const cwd = extra.cwd ?? home();
  const runtime = runtimeOn(d, owner());
  const session = await runtime.session(
    { kind: "available", via: "bundled" },
    {
      cwd,
      ...(extra.resume ? { resume: extra.resume } : {}),
      ...(extra.append ? { appendSystemPrompt: extra.append } : {}),
      ...(extra.env ? { env: extra.env } : {}),
      ...(extra.mcp ? { mcpServers: [{ name: "farm", command: process.execPath, args: [extra.mcp] }] } : {}),
    },
  );
  sessions.push(session);
  const events: Event[] = [];
  session.events((e) => events.push(e), { cursor: { sessionId: session.id, afterSeq: -1 } });
  return { session, events, requests, pending, cwd, durable: d };
}

const ended = (r: Opened) => r.events.flatMap((e) => (e.kind === "turn_ended" ? [e.outcome] : []));
const text = (r: Opened) => r.events.flatMap((e) => (e.kind === "text_delta" ? [e.text] : [])).join("");
const toolStarted = (r: Opened) => r.events.some((e) => e.kind === "tool_call_started");

describe("VibeValley's runtime", () => {
  it("shares the actual close with every concurrent caller", async () => {
    const gate = Promise.withResolvers<void>();
    let started = false;
    const held: ScriptedModel = {
      stream: async function* () {
        started = true;
        await gate.promise;
        yield* [];
      },
    };
    const d = await durable();
    seat(d, held);
    const runtime = runtimeOn(d, owner());
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: home() });
    sessions.push(session);
    const events: Event[] = [];
    session.events((event) => events.push(event), { cursor: { sessionId: session.id, afterSeq: -1 } });
    try {
      await session.prompt("work");
      await whenTrue(() => started, "the held model stream");
      const first = session.dispose();
      const second = session.dispose();
      expect(second).toBe(first);
      let done = false;
      void second.then(() => {
        done = true;
      });
      // The brain's loop lets go of a model stream that takes no notice of its stop: the close does not wait on it.
      gate.resolve();
      await Promise.all([first, second]);
      expect(done).toBe(true);
      expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "exited")).toHaveLength(1);
    } finally {
      gate.resolve();
      await session.dispose();
    }
  });

  it("cuts off a runtime's active model when its owner's scope closes", async () => {
    const parent = owner();
    let started = false;
    let cut = false;
    const held: ScriptedModel = {
      stream: async function* (_request, signal) {
        started = true;
        await new Promise<never>((_, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              cut = true;
              reject(signal.reason as unknown);
            },
            { once: true },
          ),
        );
        yield* [];
      },
    };
    const d = await durable();
    seat(d, held);
    const runtime = runtimeOn(d, parent);
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: home() });
    sessions.push(session);
    await session.prompt("work");
    await whenTrue(() => started, "the model started");
    await parent.close();
    expect(cut).toBe(true);
    await session.dispose();
  });

  it("runs a prompt's tools and ends the turn completed", async () => {
    const r = await open([answer([words("我来写"), toolCall("write", { path: "hello.txt", content: "hi" })]), answer("写好了 hello.txt")], {
      append: "你是后端老周。",
    });
    expect((await r.session.prompt("写个 hello.txt")).kind).toBe("accepted");
    await whenTrue(() => ended(r).length === 1, "ended(r).length === 1");
    expect(await readFile(join(r.cwd, "hello.txt"), "utf8")).toBe("hi");
    const kinds = new Set(r.events.map((e) => e.kind));
    for (const k of ["model", "text_delta", "tool_call_started", "tool_call_ended", "turn_ended", "usage"]) expect(kinds).toContain(k);
    const started = r.events.find((e) => e.kind === "tool_call_started");
    expect(started).toMatchObject({
      tool: "write",
      input: `{"path":"hello.txt","content":"hi"}`,
    });
    expect(r.events.find((e) => e.kind === "tool_call_ended")).toMatchObject({ result: "ok" });
    expect(ended(r)[0]!.kind).toBe("completed");
    expect(text(r)).toBe("我来写写好了 hello.txt");
    const prompt = systemPrompt(r.requests[0]!);
    expect(prompt.startsWith(helperInstructions())).toBe(true);
    expect(prompt).toContain("你是后端老周。");
  });

  it("joins a steer, waits a queued input and drops a withdrawn one", async () => {
    const r = await open([
      answer([toolCall("bash", { command: "sleep 0.2" })]),
      (c) => answer("听到：" + lastUser(c)),
      (c) => answer("排到了：" + lastUser(c)),
    ]);
    await r.session.prompt("开始");
    await whenTrue(() => toolStarted(r), "toolStarted(r)");
    expect((await r.session.prompt("又一个")).kind).toBe("rejected");
    expect((await r.session.steer!("顺便")).kind).toBe("accepted");
    await r.session.queue("然后");
    const drop = randomUUID();
    await r.session.queue("不要了", { inputId: drop });
    expect((await r.session.withdraw!(drop)).kind).toBe("accepted");
    await whenTrue(() => ended(r).length === 2, "ended(r).length === 2");
    expect(text(r)).toBe("听到：顺便排到了：然后");
    expect(r.pending()).toBe(0);
  });

  it("ends the turn aborted", async () => {
    const r = await open([answer([toolCall("bash", { command: "sleep 5" })])]);
    await r.session.prompt("睡");
    await whenTrue(() => toolStarted(r), "toolStarted(r)");
    expect((await r.session.abort()).kind).toBe("accepted");
    await whenTrue(() => ended(r).length === 1, "ended(r).length === 1");
    expect(ended(r)[0]!.kind).toBe("aborted");
    expect((await r.session.abort()).kind).toBe("rejected");
  });

  it("goes on with a resumed session", async () => {
    const count: Step = (c) => answer(`第 ${c.messages.filter((m) => m.role === "user").length} 句`);
    const first = await open([count]);
    await first.session.prompt("一");
    await whenTrue(() => ended(first).length === 1, "ended(first).length === 1");
    await first.session.dispose();
    const again = await open([count], {
      resume: first.session.id,
      durable: first.durable,
      cwd: first.cwd,
    });
    expect(again.session.id).toBe(first.session.id);
    await again.session.prompt("二");
    await whenTrue(() => ended(again).length === 1, "ended(again).length === 1");
    expect(text(again)).toBe("第 2 句");
  });

  it("goes on with the run a restart cut off, once its session is opened again", async () => {
    const words = "地里都好，三块地在长";
    const file = join(home(), "durable.db");
    const cwd = home();
    // The first process: the model is in the middle of its answer when the harness goes away, its session never let go.
    const before = await open([answer(words, { hangAfter: 3 })], {
      durable: await durable(file),
      cwd,
    });
    await before.session.prompt("地里怎么样");
    await whenTrue(() => text(before).length >= 3, "the answer under way");
    await before.durable.close();

    const after = await open([answer(words)], { durable: await durable(file), cwd, resume: before.session.id });
    await whenTrue(() => ended(after).length === 1, "the turn after the restart");
    expect(ended(after)[0]!.kind).toBe("completed");
    expect(text(after)).toBe(words);
    // Asked again once, on the input the first process took: nothing was sent twice.
    expect(after.requests).toHaveLength(1);
    expect(after.requests[0]!.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(after.requests[0]!.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("runs a command in the working directory with the session's variables, and one the session takes away gone", async () => {
    process.env["VIBEVALLEY_TEST_GONE"] = "here";
    try {
      const r = await open([answer([toolCall("bash", { command: 'echo "$PWD|$FARM_TOKEN|${VIBEVALLEY_TEST_GONE:-none}"' })]), answer("好")], {
        env: { FARM_TOKEN: "t0k", VIBEVALLEY_TEST_GONE: null },
      });
      await r.session.prompt("看看");
      await whenTrue(() => ended(r).length === 1, "ended(r).length === 1");
      const out = r.events.find((e) => e.kind === "tool_call_ended");
      expect(out).toMatchObject({ result: "ok" });
      expect(JSON.stringify(out)).toContain(`${await realpath(r.cwd)}|t0k|none`);
    } finally {
      delete process.env["VIBEVALLEY_TEST_GONE"];
    }
  });

  it("gives a spawned helper its own conversation and the model its answer", async () => {
    const r = await open([
      answer([toolCall("spawn_agent", { brief: "数一下有几个文件", label: "数文件" })]),
      (c) => answer(toolsOf(c).some((t) => t.name === "spawn_agent") ? "帮手也能派帮手" : "三个"),
      (c) => answer("帮手说：" + (c.messages.at(-1)?.role === "toolResult" ? JSON.stringify(c.messages.at(-1)) : "没回来")),
    ]);
    await r.session.prompt("派个帮手数文件");
    await whenTrue(() => ended(r).length === 1, "ended(r).length === 1");
    expect(ended(r)[0]!.kind).toBe("completed");
    expect(r.events.find((e) => e.kind === "tool_call_ended")).toMatchObject({ result: "ok", content: [{ type: "text", text: "三个" }] });
    expect(lastUser(r.requests[1]!)).toBe("数一下有几个文件");
    expect(r.pending()).toBe(0);
  });

  it("gives the model the tools of the session's MCP servers", async () => {
    const dir = home();
    await writeFile(
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
    const r = await open([answer([toolCall("farm__say", { text: "做完了" })]), (c) => answer(c.messages.at(-1)?.role === "toolResult" ? "好" : "没调到")], {
      mcp: join(dir, "farm.cjs"),
    });
    await r.session.prompt("汇报");
    await whenTrue(() => ended(r).length === 1, "ended(r).length === 1");
    expect(toolsOf(r.requests[0]!).map((t) => t.name)).toContain("farm__say");
    expect(r.events.find((e) => e.kind === "tool_call_ended")).toMatchObject({
      content: [{ type: "text", text: "说了：做完了" }],
    });
  });

  it("keeps a cut-off run's MCP tools while its session is not open again, each answering that it cannot run yet", async () => {
    const dir = home();
    await writeFile(
      join(dir, "farm.cjs"),
      `const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'farm', version: '1' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'say', description: '在田头说话', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
})`,
    );
    const file = join(home(), "durable.db");
    const before = await open([answer("汇报一下", { hangAfter: 2 })], { durable: await durable(file), mcp: join(dir, "farm.cjs") });
    await before.session.prompt("汇报");
    await whenTrue(() => text(before).length >= 2, "the answer under way");
    await before.durable.close();

    // The harness goes on with the run before the session is opened again: the MCP server is the session's own process.
    const after = await durable(file);
    const { llm, requests } = scriptedLLM([answer([toolCall("farm__say", { text: "做完了" })]), answer("好")]);
    seat(after, llm);
    after.harness.resume();
    await whenTrue(() => requests.length === 2, "the run asked again, after its call");
    expect(toolsOf(requests[0]!).map((t) => t.name)).toEqual(expect.arrayContaining(["farm__say", "bash"]));
    expect(requests[1]!.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "farm__say",
      isError: true,
      content: [{ type: "text", text: durableWords.notOpen("farm__say") }],
    });
    expect(requests[1]!.system).toBe(requests[0]!.system);
  });

  it("fails the turn when the model fails", async () => {
    const r = await open([answer("", { stopReason: "error", errorMessage: "DeepSeek 回了 503" })]);
    await r.session.prompt("试试");
    await whenTrue(() => ended(r).length === 1, "ended(r).length === 1");
    expect(ended(r)[0]).toMatchObject({ kind: "failed", reason: "DeepSeek 回了 503" });
  });

  it("lists DeepSeek's models, is bundled, and says why it cannot run", async () => {
    const d = await durable();
    seat(d, scriptedLLM().llm);
    const runtime = runtimeOn(d, owner());
    const models = await runtime.listModels();
    expect(models.kind === "ok" && models.models.some((m) => m.id === "deepseek-flash" && m.effortLevels.join(",") === "high,max" && m.default === true)).toBe(
      true,
    );
    expect(await runtime.installation()).toEqual({ kind: "available", via: "bundled" });
    await expect(runtime.session({ kind: "available", via: "bundled" }, { cwd: tmpdir(), effort: "low" })).rejects.toThrow(/只有 high、max/u);
    // Nothing seated: a farm without a DeepSeek key.
    const keyless = runtimeOn(await durable(), owner());
    expect(await keyless.installation()).toEqual({ kind: "unsupported", reason: noDeepSeekKey() });
    await expect(keyless.session({ kind: "available", via: "bundled" }, { cwd: tmpdir() })).rejects.toThrow(noDeepSeekKey());
  });
});
