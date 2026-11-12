import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { objectSchema, toolArguments } from "@vibevalley/ai/tools";
import { waitFor } from "@vibevalley/testkit/until";

import { makeBrain } from "../brain/brain.ts";
import { ToolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { effectTool } from "../core/tool.ts";
import { readMcpConfig, connectAll, mcpContentText, mcpToolName } from "../infra/mcp.ts";
import { scriptedLLM, tempHome, type TestClock, testClock } from "../testing/testing.ts";
import { codingTools, htmlText } from "./coding.ts";
import { archive, forgetLine, readMemory } from "./memory.ts";
import { describeReminder, dueReminders, makeReminders, nextRun, parseCron, type Reminder } from "./reminders.ts";
import { selfTools } from "./self.ts";
import { frontMatter, readSkill, scanSkills, skillBody } from "./skills.ts";
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
const call = async (tools: readonly Tool[], name: string, params: unknown): Promise<string> => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name}`);
  const args = toolArguments(name, params, tool.parameters);
  if ("refused" in args) throw new ToolFailed(args.refused);
  const result = await tool.execute(args.ok, { id: "t" });
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
};
/** The failure's message; a call that goes, or fails with anything but a ToolFailed, fails the test. */
const fails = async (called: Promise<string>): Promise<string> => {
  const e = await called.then(
    (said) => new Error(`expected a failure, got ${said}`),
    (e: unknown) => e,
  );
  if (!(e instanceof ToolFailed)) throw e;
  return e.message;
};
/** Reminders on the test's clock, closed with the test. */
const reminders = async (dir: string, wake: (due: string[]) => void, clock: TestClock) => {
  const made = await makeReminders(dir, wake, { clock });
  return Object.assign(made, { [Symbol.asyncDispose]: () => made.close() });
};
/** What a call rejects with. */
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("the task tools", () => {
  test("task and mark the agent's own todos", async () => {
    const tools = todoTools(memoryStore(), false, async () => undefined);
    const response = await call(tools, "todo_add", { tasks: [{ id: "fix", brief: "改", after: ["nope"] }] });
    expect(response).toMatch(/没收：「fix」要等的「nope」不存在/u);
    const fails2 = await fails(call(tools, "todo_add", { tasks: [{ id: "x", brief: "查", by: "subagent" }] }));
    expect(fails2).toMatch(/by/u);
    const added = await call(tools, "todo_add", {
      tasks: [
        { id: "read", brief: "读代码" },
        { id: "fix", title: "改 auth", brief: "改", after: ["read"] },
      ],
    });
    expect(added).toMatch(/任务（2 件，1 件可以做）/u);
    expect(added).toMatch(/\[等着\] fix 改 auth（等 read）/u);
    const response2 = await call(tools, "todo_update", { id: "read", state: "done", result: "在 jwt.go" });
    expect(response2).toMatch(/\[可以做\] fix/u);
    const fails3 = await fails(call(tools, "todo_update", { id: "read", state: "waiting" }));
    expect(fails3).toMatch(/不能改成/u);
    const response3 = await call(tools, "todo_list", {});
    expect(response3).toMatch(/read 读代码 → 在 jwt.go/u);
    const response4 = await call(tools, "todo_update", { id: "fix", state: "done" });
    expect(response4).toMatch(/都做完了，这张图收起来了。$/u);
    const response5 = await call(tools, "todo_list", {});
    expect(response5).toBe("现在没有任务。");
  });
});

describe("a tool whose work is an Effect", () => {
  test("is interrupted when the run stops", async () => {
    let interrupted = false;
    const waits = effectTool({
      name: "waits",
      description: "",
      parameters: objectSchema(),
      run: (_, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => {
            interrupted = true;
            reject(signal.reason);
          }),
        ),
    });
    const stop = new AbortController();
    const answer = failure(waits.execute({}, { id: "t" }, stop.signal));
    stop.abort();
    const answer2 = await answer;
    expect(answer2).toMatchObject({ name: "AbortError" });
    expect(interrupted).toBe(true);
  });

  test("says a failure's message as its failed result", async () => {
    const refuses = effectTool({
      name: "refuses",
      description: "",
      parameters: objectSchema(),
      run: () => Promise.reject(new ToolFailed("不行")),
    });
    const fails2 = await fails(call([refuses], "refuses", {}));
    expect(fails2).toBe("不行");
  });
});

describe("the coding tools", () => {
  test("read, write and edit a file", async () => {
    const dir = home();
    const tools = codingTools({ cwd: dir });
    const response = await call(tools, "write_file", { path: "src/a.ts", content: "one\ntwo\nthree\ntwo" });
    expect(response).toBe("写好了 src/a.ts（4 行）");
    const response2 = await call(tools, "read_file", { path: "src/a.ts", offset: 2, limit: 1 });
    expect(response2).toBe("     2\ttwo\n（共 4 行，这里到第 2 行；接着读用 offset=3）");
    const fails2 = await fails(call(tools, "edit_file", { path: "src/a.ts", old_text: "two", new_text: "2" }));
    expect(fails2).toMatch(/出现了 2 次/u);
    const fails3 = await fails(call(tools, "edit_file", { path: "src/a.ts", old_text: "four", new_text: "4" }));
    expect(fails3).toMatch(/找不到 old_text/u);
    await call(tools, "edit_file", {
      path: "src/a.ts",
      old_text: "two",
      new_text: "$&2",
      replace_all: true,
    });
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("one\n$&2\nthree\n$&2");
  });

  test("list, search and run", async () => {
    const dir = home();
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "b.txt"), "needle here\n");
    const tools = codingTools({ cwd: dir, commandTimeoutMs: 1_000 });
    const response = await call(tools, "list_dir", { depth: 2 });
    expect(response).toBe("lib/\n  b.txt");
    const found = await call(tools, "grep", { pattern: "needle" }).catch((e: unknown) => (e instanceof ToolFailed ? e.message : Promise.reject(e)));
    if (found !== "这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。") expect(found).toContain("b.txt:1:needle here");
    const response2 = await call(tools, "bash", { command: "echo hi; exit 3" });
    expect(response2).toBe("hi\n（退出码 3）");
    const response3 = await call(tools, "bash", { command: "sleep 5", timeout_seconds: 0.2 });
    expect(response3).toMatch(/超时，停掉了/u);
  });

  test("turn a web page into its words", () => {
    expect(htmlText("<html><style>x{}</style><h1>标题</h1><p>一 &amp; 二</p><script>no()</script></html>")).toBe("标题\n一 & 二");
  });
});

describe("skills and memory", () => {
  test("read front matter, and the first skill of a name wins", async () => {
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
    const body = await readSkill(skills, "tidy");
    expect(body).toMatch(/第一个的正文$/u);
    const nope = await fails(readSkill(skills, "nope"));
    expect(nope).toMatch(/有：tidy/u);
  });

  test("remember, rewrite and search the archive", async () => {
    const dir = home();
    const tools = selfTools({ now: Date.now, home: dir, skills: async () => [], memory: true });
    const memory = () => readMemory(dir);
    await call(tools, "remember", { note: "用户喜欢\n简短的回答" });
    expect((await memory()).prompt).toMatch(/^- \d{4}-\d\d-\d\d 用户喜欢 简短的回答$/u);
    await call(tools, "rewrite_memory", { content: "- 只说中文" });
    expect((await memory()).prompt).toBe("- 只说中文");
    const response = await call(tools, "search_archive", { query: "端口" });
    expect(response).toBe("还没有归档的旧对话。");
    const archivedAt = Date.now();
    await archive(dir, "s", "## 用户\n服务端口是 8787\n## 助手\n好", archivedAt);
    const response2 = await call(tools, "search_archive", { query: "端口" });
    expect(response2).toMatch(/s-.*\.md:2\n## 用户\n服务端口是 8787/u);
    expect(selfTools({ now: Date.now, home: dir, skills: async () => [], memory: false }).map((t) => t.name)).toEqual(["load_skill", "search_archive"]);
    const lines = (await memory()).lines;
    expect(lines.map((l) => l.text)).toEqual(["只说中文"]);
    await forgetLine(dir, lines[0]!.id);
    expect((await memory()).lines).toEqual([]);
  });
});

describe("reminders", () => {
  const epoch = 1798758000000;

  test("are due by their kind", () => {
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
    expect(!bad.ok && bad.problem).toMatch(/cron 写得不对/u);
    expect(describeReminder(every)).toMatch(/^- e「e」每 30 分钟；下次 /u);
  });

  test("run a missed reminder once", async () => {
    const dir = home();
    const clock = testClock(epoch);
    await using s = await reminders(dir, () => undefined, clock);
    const fails2 = await fails(call(s.tools, "reminder", { name: "x", message: "m" }));
    expect(fails2).toMatch(/正好给一个/u);
    const fails3 = await fails(call(s.tools, "reminder", { name: "x", message: "m", cron: "nope" }));
    expect(fails3).toMatch(/cron 写得不对/u);
    await call(s.tools, "reminder", { name: "巡检", message: "看看测试", every_minutes: 10 });
    await call(s.tools, "reminder", {
      name: "提醒",
      message: "开会",
      at: new Date(epoch + 60_000).toISOString(),
    });
    const response = await call(s.tools, "list_reminders", {});
    expect(response).toMatch(/「巡检」每 10 分钟[\s\S]*「提醒」/u);
    const later = new Date(epoch + 3_600_000);
    const woke = await s.claimDue(later);
    expect(woke.length).toBe(2);
    expect(woke[0]).toMatch(/^【提醒「巡检」到点了/u);
    const dueClaimed = await s.claimDue(later);
    expect(dueClaimed).toEqual([]);
    const left = JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8")) as Reminder[];
    expect(left.map((j) => j.name)).toEqual(["巡检"]);
    await call(s.tools, "cancel_reminder", { id: left[0]!.id });
    const response2 = await call(s.tools, "list_reminders", {});
    expect(response2).toBe("没有定好的事。");
  });

  test("regression: same-time reminder IDs preserve future reminders and cancel only the addressed reminder", async () => {
    const clock = testClock(epoch);
    const dir = home();
    await using s = await reminders(dir, () => undefined, clock);
    for (const [name, offset] of [
      ["first", 60_000],
      ["future", 120_000],
      ["cancel", 180_000],
    ] as const) {
      await call(s.tools, "reminder", { name, message: name, at: new Date(epoch + offset).toISOString() });
    }
    const saved = z
      .array(z.object({ id: z.string(), name: z.string(), created: z.string() }))
      .parse(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8")));
    expect(new Set(saved.map((r) => r.id)).size).toBe(3);
    expect(saved.map((r) => r.created)).toEqual(Array(3).fill(new Date(epoch).toISOString()));
    const response = await call(s.tools, "list_reminders", {});
    expect(response).toMatch(/「first」[\s\S]*「future」[\s\S]*「cancel」/u);
    await call(s.tools, "cancel_reminder", { id: saved[2]!.id });
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toMatchObject([{ id: saved[0]!.id }, { id: saved[1]!.id }]);
    const dueClaimed = await s.claimDue(new Date(epoch + 60000 - 1));
    expect(dueClaimed).toEqual([]);
    const dueClaimed2 = await s.claimDue(new Date(epoch + 60000));
    expect(dueClaimed2).toEqual([expect.stringContaining("「first」")]);
    const dueClaimed3 = await s.claimDue(new Date(epoch + 60000));
    expect(dueClaimed3).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toMatchObject([{ id: saved[1]!.id, name: "future" }]);
    const dueClaimed4 = await s.claimDue(new Date(epoch + 120000));
    expect(dueClaimed4).toEqual([expect.stringContaining("「future」")]);
  });

  test("canceling a waiting reminder and closing its scope prevent later wakes", async () => {
    const clock = testClock(epoch);
    const dir = home();
    const woke: string[] = [];
    await using s = await reminders(dir, (due) => void woke.push(...due), clock);
    await call(s.tools, "reminder", { name: "cancel", message: "", at: new Date(epoch + 60_000).toISOString() });
    await call(s.tools, "reminder", { name: "keep", message: "", at: new Date(epoch + 120_000).toISOString() });
    const saved = z.array(z.object({ id: z.string() })).parse(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8")));
    await call(s.tools, "cancel_reminder", { id: saved[0]!.id });
    await clock.adjust(60_000);
    expect(woke).toEqual([]);
    await clock.adjust(60_000);
    await waitFor(
      () => woke.length,
      (n) => n === 1,
      "uncanceled reminder wakes",
    );
    expect(woke).toEqual([expect.stringContaining("「keep」")]);
    await call(s.tools, "reminder", { name: "closed", message: "", at: new Date(epoch + 180_000).toISOString() });
    await s.close();
    await clock.adjust(60_000);
    expect(woke).toEqual([expect.stringContaining("「keep」")]);
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toMatchObject([{ name: "closed" }]);
  });

  test("wake the agent when one comes due, on the Clock, and what came due while away at once", async () => {
    const dir = home();
    const start = new Date("2026-10-12T00:00:00.000Z").getTime();
    const clock = testClock(start);
    writeFileSync(
      join(dir, "reminders.json"),
      JSON.stringify([
        { id: "missed", name: "错过的", message: "", at: new Date(start - 60_000).toISOString(), created: new Date(start - 3_600_000).toISOString() },
        { id: "soon", name: "一会儿", message: "", at: new Date(start + 10 * 60_000).toISOString(), created: new Date(start).toISOString() },
      ]),
    );
    const woke: string[] = [];
    const storedAtWake: unknown[] = [];
    await using _s = await reminders(
      dir,
      (due) => {
        storedAtWake.push(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8")));
        woke.push(...due);
      },
      clock,
    );
    await waitFor(
      () => woke.length,
      (n) => n === 1,
      "the missed one",
    );
    expect(woke[0]).toMatch(/错过的/u);
    expect(storedAtWake).toEqual([[expect.objectContaining({ id: "soon" })]]);
    await clock.adjust(10 * 60_000 - 1);
    expect(woke.length).toBe(1);
    await clock.adjust(1);
    await waitFor(
      () => woke.length,
      (n) => n === 2,
      "the one due now",
    );
    expect(woke[1]).toMatch(/一会儿/u);
    expect(storedAtWake[1]).toEqual([]);
  });

  test("come due only once the claim is stored", async () => {
    const dir = home();
    const clock = testClock(epoch);
    const now = new Date(epoch + 60_000);
    writeFileSync(
      join(dir, "reminders.json"),
      JSON.stringify([
        {
          id: "once",
          name: "",
          message: "",
          at: now.toISOString(),
          created: new Date(epoch).toISOString(),
        },
      ]),
    );
    // A directory at the temporary file's path makes the atomic write fail.
    mkdirSync(join(dir, "reminders.json.tmp"));
    const woke: string[] = [];
    await using s = await reminders(dir, (due) => void woke.push(...due), clock);
    const firstClaim = await failure(s.claimDue(now));
    expect(firstClaim).toMatchObject({ _tag: "AgentFailed" });
    const secondClaim = await failure(s.claimDue(now));
    expect(secondClaim).toMatchObject({ _tag: "AgentFailed" });
    expect(woke).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toMatchObject([{ id: "once" }]);
    rmdirSync(join(dir, "reminders.json.tmp"));
    expect((await s.claimDue(now)).length).toBe(1);
    const dueClaimed = await s.claimDue(now);
    expect(dueClaimed).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toEqual([]);
  });

  test("do not run a persisted reminder whose shape is wrong", async () => {
    const dir = home();
    const clock = testClock(epoch);
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
    await using s = await reminders(dir, () => undefined, clock);
    const now = clock.now();
    const claim = await failure(s.claimDue(new Date(now)));
    expect(claim).toMatchObject({ _tag: "AgentFailed" });
    expect(readFileSync(join(dir, "reminders.json"), "utf8")).toBe(damaged);
  });

  test("do not read a damaged file as an empty list", async () => {
    const dir = home();
    const clock = testClock(epoch);
    const damaged = `[{"id":"important"`;
    writeFileSync(join(dir, "reminders.json"), damaged);
    await using s = await reminders(dir, () => undefined, clock);
    await fails(call(s.tools, "reminder", { name: "new", message: "work", every_minutes: 5 }));
    await fails(call(s.tools, "list_reminders", {}));
    const now = clock.now();
    const claim = await failure(s.claimDue(new Date(now)));
    expect(claim).toMatchObject({ _tag: "AgentFailed" });
    expect(readFileSync(join(dir, "reminders.json"), "utf8")).toBe(damaged);
  });
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
  test("names tools and reads their content", () => {
    expect(mcpToolName("my server", "a.b")).toBe("my_server__a_b");
    expect(mcpContentText([{ type: "text", text: "a" }, { type: "image" }, { type: "resource", resource: { uri: "file:///x" } }])).toBe(
      "a\n[image]\n[file:///x]",
    );
  });

  test("reads the servers people configure", async () => {
    const dir = home();
    const file = join(dir, "mcp.json");
    const missing = await readMcpConfig(file);
    expect(missing).toEqual([]);
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
    const servers = await readMcpConfig(file);
    expect(servers).toEqual([
      { name: "calc", command: "node", args: ["c.js"] },
      { name: "web", url: "http://x", headers: { a: "b" } },
    ]);
    writeFileSync(file, `{"mcpServers":[]}`);
    expect(await failure(readMcpConfig(file))).toMatchObject({ message: expect.stringMatching(/形状不对/u) });
    writeFileSync(file, "nope");
    expect(await failure(readMcpConfig(file))).toMatchObject({ message: expect.stringMatching(/不是 JSON/u) });
    const directory = join(dir, "directory");
    mkdirSync(directory);
    const notAFile = await failure(readMcpConfig(directory));
    expect(notAFile).toMatchObject({ _tag: "AgentFailed" });
  });

  test("gets a server's tools over stdio, every page, and leaves out one that cannot be reached", async () => {
    const dir = home();
    writeFileSync(join(dir, "fake.cjs"), fakeMCP);
    const all = await connectAll([
      { name: "calc", command: process.execPath, args: [join(dir, "fake.cjs")] },
      { name: "gone", command: join(dir, "no-such-server") },
    ]);
    await using _closed = { [Symbol.asyncDispose]: () => all.close() };
    expect(all.tools.map((t) => t.name)).toEqual(["calc__add", "calc__boom"]);
    expect(all.failed.length).toBe(1);
    expect(all.failed[0]).toMatch(/^连不上 MCP 服务 gone/u);
    const response = await call(all.tools, "calc__add", { a: 2, b: 3 });
    expect(response).toBe("5");
    const fails2 = await fails(call(all.tools, "calc__boom", {}));
    expect(fails2).toBe("炸了");
  });

  test("belongs to the agent that connected it", async () => {
    const dir = home();
    writeFileSync(join(dir, "mcp.cjs"), fakeMCP);
    // The brain's scope is this one: its end closes the brain, and its MCP servers with it.
    const tools = await (async () => {
      await using agent = await makeBrain({
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
      const response = await call(agent.tools(), "calc__add", { a: 2, b: 3 });
      expect(response).toBe("5");
      return agent.tools();
    })();
    await fails(call(tools, "calc__add", { a: 2, b: 3 }));
    expect(existsSync(join(dir, "test.jsonl"))).toBe(false);
  });
});
