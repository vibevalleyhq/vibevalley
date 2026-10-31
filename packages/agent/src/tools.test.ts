import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import { objectSchema, toolArguments } from "@vibevalley/ai/tools";
import { waitFor } from "@vibevalley/testkit/until";

import { makeBrain } from "./brain.ts";
import { codingTools, htmlText } from "./coding.ts";
import { ToolFailed } from "./core/errors.ts";
import type { Tool } from "./core/loop.ts";
import { effectTool } from "./core/tool.ts";
import { readMcpConfig, connectAll, mcpContentText, mcpToolName } from "./mcp.ts";
import { archive, forgetLine, readMemory } from "./memory.ts";
import { describeReminder, dueReminders, makeReminders, nextRun, parseCron, type Reminder } from "./reminders.ts";
import { selfTools } from "./self.ts";
import { frontMatter, readSkill, scanSkills, skillBody } from "./skills.ts";
import { scriptedLLM, tempHome } from "./testing.ts";
import { memoryStore } from "./todoStore.ts";
import { todoTools } from "./todoTools.ts";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

/** As the agent calls it: arguments checked first, a bad one said as a failure. */
const call = Effect.fnUntraced(function* (tools: readonly Tool[], name: string, params: unknown) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return yield* Effect.die(new Error(`no ${name}`));
  const args = toolArguments(name, params, tool.parameters);
  if ("refused" in args) return yield* new ToolFailed({ message: args.refused });
  const result = yield* tool.execute(args.ok, { id: "t" });
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
});
/** The failure's message; a call that goes fails the test. */
const fails = (called: Effect.Effect<string, ToolFailed>) => Effect.map(Effect.flip(called), (e) => e.message);

describe("the task tools", () => {
  it.effect("task and mark the agent's own todos", () =>
    Effect.gen(function* () {
      const tools = todoTools(memoryStore(), false, Effect.void);
      expect(yield* call(tools, "todo_add", { tasks: [{ id: "fix", brief: "改", after: ["nope"] }] })).toMatch(/没收：「fix」要等的「nope」不存在/u);
      expect(yield* fails(call(tools, "todo_add", { tasks: [{ id: "x", brief: "查", by: "subagent" }] }))).toMatch(/by/u);
      const added = yield* call(tools, "todo_add", {
        tasks: [
          { id: "read", brief: "读代码" },
          { id: "fix", title: "改 auth", brief: "改", after: ["read"] },
        ],
      });
      expect(added).toMatch(/任务（2 件，1 件可以做）/u);
      expect(added).toMatch(/\[等着\] fix 改 auth（等 read）/u);
      expect(yield* call(tools, "todo_update", { id: "read", state: "done", result: "在 jwt.go" })).toMatch(/\[可以做\] fix/u);
      expect(yield* fails(call(tools, "todo_update", { id: "read", state: "waiting" }))).toMatch(/不能改成/u);
      expect(yield* call(tools, "todo_list", {})).toMatch(/read 读代码 → 在 jwt.go/u);
      expect(yield* call(tools, "todo_update", { id: "fix", state: "done" })).toMatch(/都做完了，这张图收起来了。$/u);
      expect(yield* call(tools, "todo_list", {})).toBe("现在没有任务。");
    }),
  );
});

describe("a tool whose work is an Effect", () => {
  it.effect("is interrupted when the run stops", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const waits = effectTool({
        name: "waits",
        description: "",
        parameters: objectSchema(),
        run: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      });
      const answer = yield* Effect.forkChild(waits.execute({}, { id: "t" }), { startImmediately: true });
      yield* Fiber.interrupt(answer);
      expect(Exit.hasInterrupts(yield* Fiber.await(answer))).toBe(true);
      expect(interrupted).toBe(true);
    }),
  );

  it.effect("says a failure's message as its failed result", () =>
    Effect.gen(function* () {
      const refuses = effectTool({ name: "refuses", description: "", parameters: objectSchema(), run: () => Effect.fail(new ToolFailed({ message: "不行" })) });
      expect(yield* fails(call([refuses], "refuses", {}))).toBe("不行");
    }),
  );
});

describe("the coding tools", () => {
  it.effect("read, write and edit a file", () =>
    Effect.gen(function* () {
      const dir = home();
      const tools = codingTools({ cwd: dir });
      expect(yield* call(tools, "write_file", { path: "src/a.ts", content: "one\ntwo\nthree\ntwo" })).toBe("写好了 src/a.ts（4 行）");
      expect(yield* call(tools, "read_file", { path: "src/a.ts", offset: 2, limit: 1 })).toBe("     2\ttwo\n（共 4 行，这里到第 2 行；接着读用 offset=3）");
      expect(yield* fails(call(tools, "edit_file", { path: "src/a.ts", old_text: "two", new_text: "2" }))).toMatch(/出现了 2 次/u);
      expect(yield* fails(call(tools, "edit_file", { path: "src/a.ts", old_text: "four", new_text: "4" }))).toMatch(/找不到 old_text/u);
      yield* call(tools, "edit_file", {
        path: "src/a.ts",
        old_text: "two",
        new_text: "$&2",
        replace_all: true,
      });
      expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("one\n$&2\nthree\n$&2");
    }),
  );

  it.effect("list, search and run", () =>
    Effect.gen(function* () {
      const dir = home();
      mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "b.txt"), "needle here\n");
      const tools = codingTools({ cwd: dir, commandTimeoutMs: 1_000 });
      expect(yield* call(tools, "list_dir", { depth: 2 })).toBe("lib/\n  b.txt");
      const found = yield* Effect.catch(call(tools, "grep", { pattern: "needle" }), (e) => Effect.succeed(e.message));
      if (found !== "这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。") expect(found).toContain("b.txt:1:needle here");
      expect(yield* call(tools, "bash", { command: "echo hi; exit 3" })).toBe("hi\n（退出码 3）");
      expect(yield* call(tools, "bash", { command: "sleep 5", timeout_seconds: 0.2 })).toMatch(/超时，停掉了/u);
    }),
  );

  it("turn a web page into its words", () => {
    expect(htmlText("<html><style>x{}</style><h1>标题</h1><p>一 &amp; 二</p><script>no()</script></html>")).toBe("标题\n一 & 二");
  });
});

describe("skills and memory", () => {
  it("read front matter, and the first skill of a name wins", async () => {
    const dir = home();
    expect(frontMatter('---\nname: "tidy"\ndescription: >\n  整理代码\n  时用\n---\nbody')).toEqual({ name: "tidy", description: "整理代码 时用" });
    expect(skillBody("---\nname: x\n---\n\n正文")).toBe("正文");
    for (const [d, words] of [
      ["a", "第一个"],
      ["b", "第二个"],
    ] as const) {
      mkdirSync(join(dir, d, "tidy"), { recursive: true });
      writeFileSync(join(dir, d, "tidy", "SKILL.md"), `---\nname: tidy\ndescription: ${words}\n---\n${words}的正文`);
    }
    const skills = await scanSkills([join(dir, "a"), join(dir, "b"), join(dir, "missing")]);
    expect(skills.length).toBe(1);
    expect(skills[0]!.description).toBe("第一个");
    expect(await readSkill(skills, "tidy")).toMatch(/第一个的正文$/u);
    await expect(readSkill(skills, "nope")).rejects.toThrow(/有：tidy/u);
  });

  it.effect("remember, rewrite and search the archive", () =>
    Effect.gen(function* () {
      const dir = home();
      const tools = selfTools({ now: Date.now, home: dir, skills: async () => [], memory: true });
      const memory = () => Effect.promise(() => readMemory(dir));
      yield* call(tools, "remember", { note: "用户喜欢\n简短的回答" });
      expect((yield* memory()).prompt).toMatch(/^- \d{4}-\d\d-\d\d 用户喜欢 简短的回答$/u);
      yield* call(tools, "rewrite_memory", { content: "- 只说中文" });
      expect((yield* memory()).prompt).toBe("- 只说中文");
      expect(yield* call(tools, "search_archive", { query: "端口" })).toBe("还没有归档的旧对话。");
      yield* Effect.promise(() => archive(dir, "s", "## 用户\n服务端口是 8787\n## 助手\n好", new Date()));
      expect(yield* call(tools, "search_archive", { query: "端口" })).toMatch(/s-.*\.md:2\n## 用户\n服务端口是 8787/u);
      expect(selfTools({ now: Date.now, home: dir, skills: async () => [], memory: false }).map((t) => t.name)).toEqual(["load_skill", "search_archive"]);
      const lines = (yield* memory()).lines;
      expect(lines.map((l) => l.text)).toEqual(["只说中文"]);
      yield* Effect.promise(() => forgetLine(dir, lines[0]!.id));
      expect((yield* memory()).lines).toEqual([]);
    }),
  );
});

describe("reminders", () => {
  it("are due by their kind", () => {
    const created = "2026-10-12T00:00:00.000Z";
    const at: Reminder = { id: "a", name: "a", message: "", at: "2026-10-12T01:00:00.000Z", created };
    const every: Reminder = { id: "e", name: "e", message: "", everyMinutes: 30, created };
    const cron: Reminder = { id: "c", name: "c", message: "", cron: "0 * * * *", created };
    expect(nextRun(at)!.toISOString()).toBe("2026-10-12T01:00:00.000Z");
    expect(nextRun({ ...at, lastRun: "2026-10-12T01:00:00.000Z" })).toBeUndefined();
    expect(nextRun(every)!.toISOString()).toBe("2026-10-12T00:30:00.000Z");
    expect(nextRun(cron)!.getUTCMinutes()).toBe(0);
    expect(nextRun({ ...cron, cron: "every day" })).toBeUndefined();
    expect(dueReminders([at, every, cron], new Date("2026-10-12T00:45:00.000Z")).map((j) => j.id)).toEqual(["e"]);
    const bad = parseCron("every day");
    expect(Result.isFailure(bad) && bad.failure).toMatch(/cron 写得不对/u);
    expect(describeReminder(every)).toMatch(/^- e「e」每 30 分钟；下次 /u);
  });

  it.effect("run a missed reminder once", () =>
    Effect.gen(function* () {
      const dir = home();
      // Each reminder is made at a moment of its own: the clock moves on a millisecond each time it is read.
      let at = Date.now();
      const s = yield* makeReminders(
        dir,
        () => ++at,
        () => Effect.void,
      );
      expect(yield* fails(call(s.tools, "reminder", { name: "x", message: "m" }))).toMatch(/正好给一个/u);
      expect(yield* fails(call(s.tools, "reminder", { name: "x", message: "m", cron: "nope" }))).toMatch(/cron 写得不对/u);
      yield* call(s.tools, "reminder", { name: "巡检", message: "看看测试", every_minutes: 10 });
      yield* call(s.tools, "reminder", {
        name: "提醒",
        message: "开会",
        at: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(yield* call(s.tools, "list_reminders", {})).toMatch(/「巡检」每 10 分钟[\s\S]*「提醒」/u);
      const later = new Date(Date.now() + 3_600_000);
      const woke = yield* s.claimDue(later);
      expect(woke.length).toBe(2);
      expect(woke[0]).toMatch(/^【提醒「巡检」到点了/u);
      expect(yield* s.claimDue(later)).toEqual([]);
      const left = JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8")) as Reminder[];
      expect(left.map((j) => j.name)).toEqual(["巡检"]);
      yield* call(s.tools, "cancel_reminder", { id: left[0]!.id });
      expect(yield* call(s.tools, "list_reminders", {})).toBe("没有定好的事。");
    }),
  );

  it.effect("wake the agent when one comes due, on the Clock, and what came due while away at once", () =>
    Effect.gen(function* () {
      const dir = home();
      const start = new Date("2026-10-12T00:00:00.000Z").getTime();
      yield* TestClock.setTime(start);
      writeFileSync(
        join(dir, "reminders.json"),
        JSON.stringify([
          { id: "missed", name: "错过的", message: "", at: new Date(start - 60_000).toISOString(), created: new Date(start - 3_600_000).toISOString() },
          { id: "soon", name: "一会儿", message: "", at: new Date(start + 10 * 60_000).toISOString(), created: new Date(start).toISOString() },
        ]),
      );
      const woke: string[] = [];
      const clock = yield* Clock.Clock;
      yield* makeReminders(
        dir,
        () => clock.currentTimeMillisUnsafe(),
        (due) => Effect.sync(() => void woke.push(...due)),
      );
      yield* waitFor(
        Effect.sync(() => woke.length),
        (n) => n === 1,
        "the missed one",
      );
      expect(woke[0]).toMatch(/错过的/u);
      yield* TestClock.adjust(10 * 60_000 - 1);
      expect(woke.length).toBe(1);
      yield* TestClock.adjust(1);
      yield* waitFor(
        Effect.sync(() => woke.length),
        (n) => n === 2,
        "the one due now",
      );
      expect(woke[1]).toMatch(/一会儿/u);
    }),
  );

  it.effect("come due only once the claim is stored", () =>
    Effect.gen(function* () {
      const dir = home();
      const now = new Date();
      writeFileSync(
        join(dir, "reminders.json"),
        JSON.stringify([
          {
            id: "once",
            name: "",
            message: "",
            at: new Date(now.getTime() - 60_000).toISOString(),
            created: new Date(now.getTime() - 3_600_000).toISOString(),
          },
        ]),
      );
      // A directory at the temporary file's path makes the atomic write fail.
      mkdirSync(join(dir, "reminders.json.tmp"));
      const s = yield* makeReminders(dir, Date.now, () => Effect.void);
      yield* Effect.flip(s.claimDue(now));
      yield* Effect.flip(s.claimDue(now));
      rmdirSync(join(dir, "reminders.json.tmp"));
      expect((yield* s.claimDue(now)).length).toBe(1);
      expect(yield* s.claimDue(now)).toEqual([]);
    }),
  );

  it.effect("do not run a persisted reminder whose shape is wrong", () =>
    Effect.gen(function* () {
      const dir = home();
      const damaged = JSON.stringify([
        {
          id: "important",
          name: "",
          message: "",
          everyMinutes: "5",
          created: new Date(0).toISOString(),
        },
      ]);
      writeFileSync(join(dir, "reminders.json"), damaged);
      const s = yield* makeReminders(dir, Date.now, () => Effect.void);
      yield* Effect.flip(s.claimDue(new Date()));
      expect(readFileSync(join(dir, "reminders.json"), "utf8")).toBe(damaged);
    }),
  );

  it.effect("do not read a damaged file as an empty list", () =>
    Effect.gen(function* () {
      const dir = home();
      const damaged = `[{"id":"important"`;
      writeFileSync(join(dir, "reminders.json"), damaged);
      const s = yield* makeReminders(dir, Date.now, () => Effect.void);
      yield* fails(call(s.tools, "reminder", { name: "new", message: "work", every_minutes: 5 }));
      yield* fails(call(s.tools, "list_reminders", {}));
      yield* Effect.flip(s.claimDue(new Date()));
      expect(readFileSync(join(dir, "reminders.json"), "utf8")).toBe(damaged);
    }),
  );
});

const fakeMCP = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  else if (m.method === 'tools/list' && !(m.params && m.params.cursor)) send({ id: m.id, result: { tools: [{ name: 'add', description: 'adds', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }], nextCursor: 'p2' } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'boom', inputSchema: { type: 'object' } }] } })
  else if (m.method === 'tools/call' && m.params.name === 'add') send({ id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '炸了' }], isError: true } })
})
`;

describe("MCP", () => {
  it("names tools and reads their content", () => {
    expect(mcpToolName("my server", "a.b")).toBe("my_server__a_b");
    expect(mcpContentText([{ type: "text", text: "a" }, { type: "image" }, { type: "resource", resource: { uri: "file:///x" } }])).toBe(
      "a\n[image]\n[file:///x]",
    );
  });

  it("reads the servers people configure", async () => {
    const dir = home();
    const file = join(dir, "mcp.json");
    expect(await readMcpConfig(file)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          web: { url: "http://x", headers: { a: "b" } },
          off: { command: "x", disabled: true },
          calc: { command: "node", args: ["c.js"] },
        },
      }),
    );
    expect(await readMcpConfig(file)).toEqual([
      { name: "calc", command: "node", args: ["c.js"] },
      { name: "web", url: "http://x", headers: { a: "b" } },
    ]);
    writeFileSync(file, `{"mcpServers":[]}`);
    await expect(readMcpConfig(file)).rejects.toThrow(/形状不对/u);
    writeFileSync(file, "nope");
    await expect(readMcpConfig(file)).rejects.toThrow(/不是 JSON/u);
    const directory = join(dir, "directory");
    mkdirSync(directory);
    await expect(readMcpConfig(directory)).rejects.toThrow();
  });

  it.effect("gets a server's tools over stdio, every page, and leaves out one that cannot be reached", () =>
    Effect.gen(function* () {
      const dir = home();
      writeFileSync(join(dir, "fake.cjs"), fakeMCP);
      const all = yield* Effect.acquireRelease(
        Effect.promise(() =>
          connectAll([
            { name: "calc", command: process.execPath, args: [join(dir, "fake.cjs")] },
            { name: "gone", command: join(dir, "no-such-server") },
          ]),
        ),
        (connected) => Effect.promise(() => connected.close()),
      );
      expect(all.tools.map((t) => t.name)).toEqual(["calc__add", "calc__boom"]);
      expect(all.failed.length).toBe(1);
      expect(all.failed[0]).toMatch(/^连不上 MCP 服务 gone/u);
      expect(yield* call(all.tools, "calc__add", { a: 2, b: 3 })).toBe("5");
      expect(yield* fails(call(all.tools, "calc__boom", {}))).toBe("炸了");
    }),
  );

  it.effect("belongs to the agent that connected it", () =>
    Effect.gen(function* () {
      const dir = home();
      writeFileSync(join(dir, "mcp.cjs"), fakeMCP);
      // The brain's scope is this one: its end closes the brain, and its MCP servers with it.
      const tools = yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* makeBrain({
            name: "test",
            instructions: "",
            llm: scriptedLLM().llm,
            home: dir,
            cwd: dir,
            noSession: true,
            noSkills: true,
            noSubagents: true,
            mcpServers: [
              { name: "calc", command: process.execPath, args: [join(dir, "mcp.cjs")] },
              { name: "gone", command: join(dir, "missing") },
            ],
          });
          const status = agent.mcpStatus();
          expect(status.toolCount).toBe(2);
          expect(status.failed.length).toBe(1);
          expect(yield* call(agent.tools(), "calc__add", { a: 2, b: 3 })).toBe("5");
          return agent.tools();
        }),
      );
      yield* fails(call(tools, "calc__add", { a: 2, b: 3 }));
      expect(existsSync(join(dir, "test.jsonl"))).toBe(false);
    }),
  );
});
