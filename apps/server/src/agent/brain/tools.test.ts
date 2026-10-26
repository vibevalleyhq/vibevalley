import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { memoryStore } from "./agentTaskStore.ts";
import { Brain } from "./agent.ts";
import { codingTools, htmlText } from "./coding.ts";
import { readMcpConfig } from "./config.ts";
import { connectAll, mcpContentText, mcpToolName } from "./mcp.ts";
import { archive, forgetLine, readMemory } from "./memory.ts";
import { describeReminder, dueReminders, nextRun, parseCron, type Reminder, Reminders } from "./reminders.ts";
import { selfTools } from "./self.ts";
import { frontMatter, readSkill, scanSkills, skillBody } from "./skills.ts";
import { taskTools } from "./agentTaskTools.ts";
import { fauxLLM, tempHome } from "./testing.ts";
import { wallTime } from "../../base/time.ts";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

/** As the agent calls it: arguments checked first, a bad one said as an error. */
async function call(tools: readonly AgentTool[], name: string, params: unknown): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name}`);
  const args = validateToolArguments(tool, {
    type: "toolCall",
    id: "t",
    name,
    arguments: params as never,
  });
  const result = await tool.execute("t", args);
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
const fails = async (p: Promise<string>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a failure");
};

describe("the task tools", () => {
  it("task and mark the agent's own tasks", async () => {
    const tools = taskTools(memoryStore(), false, () => {});
    expect(await call(tools, "task_add", { tasks: [{ id: "fix", brief: "改", after: ["nope"] }] })).toMatch(/没收：「fix」要等的「nope」不存在/);
    expect(await fails(call(tools, "task_add", { tasks: [{ id: "x", brief: "查", by: "subagent" }] }))).toMatch(/by/);
    const added = await call(tools, "task_add", {
      tasks: [
        { id: "read", brief: "读代码" },
        { id: "fix", title: "改 auth", brief: "改", after: ["read"] },
      ],
    });
    expect(added).toMatch(/任务（2 件，1 件可以做）/);
    expect(added).toMatch(/\[等着\] fix 改 auth（等 read）/);
    expect(await call(tools, "task_update", { id: "read", state: "done", result: "在 jwt.go" })).toMatch(/\[可以做\] fix/);
    expect(await fails(call(tools, "task_update", { id: "read", state: "waiting" }))).toMatch(/不能改成/);
    expect(await call(tools, "task_graph", {})).toMatch(/read 读代码 → 在 jwt.go/);
    expect(await call(tools, "task_update", { id: "fix", state: "done" })).toMatch(/都做完了，这张图收起来了。$/);
    expect(await call(tools, "task_graph", {})).toBe("现在没有任务。");
  });
});

describe("the coding tools", () => {
  it("read, write and edit a file", async () => {
    const dir = home();
    const tools = codingTools({ cwd: dir });
    expect(await call(tools, "write_file", { path: "src/a.ts", content: "one\ntwo\nthree\ntwo" })).toBe("写好了 src/a.ts（4 行）");
    expect(await call(tools, "read_file", { path: "src/a.ts", offset: 2, limit: 1 })).toBe("     2\ttwo\n（共 4 行，这里到第 2 行；接着读用 offset=3）");
    expect(await fails(call(tools, "edit_file", { path: "src/a.ts", old_text: "two", new_text: "2" }))).toMatch(/出现了 2 次/);
    expect(await fails(call(tools, "edit_file", { path: "src/a.ts", old_text: "four", new_text: "4" }))).toMatch(/找不到 old_text/);
    await call(tools, "edit_file", {
      path: "src/a.ts",
      old_text: "two",
      new_text: "$&2",
      replace_all: true,
    });
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("one\n$&2\nthree\n$&2");
  });

  it("list, search and run", async () => {
    const dir = home();
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "b.txt"), "needle here\n");
    const tools = codingTools({ cwd: dir, commandTimeoutMs: 1_000 });
    expect(await call(tools, "list_dir", { depth: 2 })).toBe("lib/\n  b.txt");
    const found = await call(tools, "grep", { pattern: "needle" }).catch((e: Error) => e.message);
    if (found !== "这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。") expect(found).toContain("b.txt:1:needle here");
    expect(await call(tools, "bash", { command: "echo hi; exit 3" })).toBe("hi\n（退出码 3）");
    expect(await call(tools, "bash", { command: "sleep 5", timeout_seconds: 0.2 })).toMatch(/超时，停掉了/);
  });

  it("turn a web page into its words", () => {
    expect(htmlText("<html><style>x{}</style><h1>标题</h1><p>一 &amp; 二</p><script>no()</script></html>")).toBe("标题\n一 & 二");
  });
});

describe("skills and memory", () => {
  it("read front matter, and the first skill of a name wins", () => {
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
    const skills = scanSkills([join(dir, "a"), join(dir, "b"), join(dir, "missing")]);
    expect(skills.length).toBe(1);
    expect(skills[0]!.description).toBe("第一个");
    expect(readSkill(skills, "tidy")).toMatch(/第一个的正文$/);
    expect(() => readSkill(skills, "nope")).toThrow(/有：tidy/);
  });

  it("remember, rewrite and search the archive", async () => {
    const dir = home();
    const tools = selfTools({ now: wallTime.now, home: dir, skills: () => [], memory: true });
    await call(tools, "remember", { note: "用户喜欢\n简短的回答" });
    expect(readMemory(dir).prompt).toMatch(/^- \d{4}-\d\d-\d\d 用户喜欢 简短的回答$/);
    await call(tools, "rewrite_memory", { content: "- 只说中文" });
    expect(readMemory(dir).prompt).toBe("- 只说中文");
    expect(await call(tools, "search_archive", { query: "端口" })).toBe("还没有归档的旧对话。");
    archive(dir, "s", "## 用户\n服务端口是 8787\n## 助手\n好", new Date());
    expect(await call(tools, "search_archive", { query: "端口" })).toMatch(/s-.*\.md:2\n## 用户\n服务端口是 8787/);
    expect(selfTools({ now: wallTime.now, home: dir, skills: () => [], memory: false }).map((t) => t.name)).toEqual(["load_skill", "search_archive"]);
    const lines = readMemory(dir).lines;
    expect(lines.map((l) => l.text)).toEqual(["只说中文"]);
    forgetLine(dir, lines[0]!.id);
    expect(readMemory(dir).lines).toEqual([]);
  });
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
    expect(dueReminders([at, every, cron], new Date("2026-10-12T00:45:00.000Z")).map((j) => j.id)).toEqual(["e"]);
    expect(() => parseCron("every day")).toThrow(/cron 写得不对/);
    expect(describeReminder(every)).toMatch(/^- e「e」每 30 分钟；下次 /);
  });

  it("run a missed reminder once", async () => {
    const dir = home();
    const woke: string[] = [];
    // Each reminder is made at a moment of its own: the clock moves on a millisecond each time it is read.
    let at = wallTime.now();
    const s = new Reminders(dir, (text) => woke.push(text), { ...wallTime, now: () => ++at });
    expect(await fails(call(s.tools, "reminder", { name: "x", message: "m" }))).toMatch(/正好给一个/);
    expect(await fails(call(s.tools, "reminder", { name: "x", message: "m", cron: "nope" }))).toMatch(/cron 写得不对/);
    await call(s.tools, "reminder", { name: "巡检", message: "看看测试", every_minutes: 10 });
    await call(s.tools, "reminder", {
      name: "提醒",
      message: "开会",
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await call(s.tools, "list_reminders", {})).toMatch(/「巡检」每 10 分钟[\s\S]*「提醒」/);
    const later = new Date(Date.now() + 3_600_000);
    s.tick(later);
    expect(woke.length).toBe(2);
    expect(woke[0]).toMatch(/^【提醒「巡检」到点了/);
    s.tick(later);
    expect(woke.length).toBe(2);
    const left = JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8")) as Reminder[];
    expect(left.map((j) => j.name)).toEqual(["巡检"]);
    await call(s.tools, "cancel_reminder", { id: left[0]!.id });
    expect(await call(s.tools, "list_reminders", {})).toBe("没有定好的事。");
  });

  it("wake only once the claim is stored", () => {
    const dir = home();
    let wakes = 0;
    const s = new Reminders(dir, () => wakes++, wallTime);
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
    s.tick(now);
    s.tick(now);
    expect(wakes).toBe(0);
    rmdirSync(join(dir, "reminders.json.tmp"));
    s.tick(now);
    s.tick(now);
    expect(wakes).toBe(1);
  });

  it("do not run a persisted reminder whose shape is wrong", () => {
    const dir = home();
    const woke: string[] = [];
    const s = new Reminders(dir, (text) => woke.push(text), wallTime);
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
    s.tick(new Date());
    expect(woke).toEqual([]);
    expect(readFileSync(join(dir, "reminders.json"), "utf8")).toBe(damaged);
  });

  it("do not read a damaged file as an empty list", async () => {
    const dir = home();
    const s = new Reminders(
      dir,
      () => {
        throw new Error("unexpected wake");
      },
      wallTime,
    );
    const damaged = `[{"id":"important"`;
    writeFileSync(join(dir, "reminders.json"), damaged);
    await fails(call(s.tools, "reminder", { name: "new", message: "work", every_minutes: 5 }));
    await fails(call(s.tools, "list_reminders", {}));
    s.tick();
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
  it("names tools and reads their content", () => {
    expect(mcpToolName("my server", "a.b")).toBe("my_server__a_b");
    expect(mcpContentText([{ type: "text", text: "a" }, { type: "image" }, { type: "resource", resource: { uri: "file:///x" } }])).toBe(
      "a\n[image]\n[file:///x]",
    );
  });

  it("reads the servers people configure", () => {
    const dir = home();
    const file = join(dir, "mcp.json");
    expect(readMcpConfig(file)).toEqual([]);
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
    expect(readMcpConfig(file)).toEqual([
      { name: "calc", command: "node", args: ["c.js"] },
      { name: "web", url: "http://x", headers: { a: "b" } },
    ]);
    writeFileSync(file, `{"mcpServers":[]}`);
    expect(() => readMcpConfig(file)).toThrow(/形状不对/);
    writeFileSync(file, "nope");
    expect(() => readMcpConfig(file)).toThrow(/不是 JSON/);
    const directory = join(dir, "directory");
    mkdirSync(directory);
    expect(() => readMcpConfig(directory)).toThrow();
  });

  it("gets a server's tools over stdio, every page, and leaves out one that cannot be reached", async () => {
    const dir = home();
    writeFileSync(join(dir, "fake.cjs"), fakeMCP);
    const all = await connectAll([
      { name: "calc", command: process.execPath, args: [join(dir, "fake.cjs")] },
      { name: "gone", command: join(dir, "no-such-server") },
    ]);
    try {
      expect(all.tools.map((t) => t.name)).toEqual(["calc__add", "calc__boom"]);
      expect(all.failed.length).toBe(1);
      expect(all.failed[0]).toMatch(/^连不上 MCP 服务 gone/);
      expect(await call(all.tools, "calc__add", { a: 2, b: 3 })).toBe("5");
      expect(await fails(call(all.tools, "calc__boom", {}))).toBe("炸了");
    } finally {
      await all.close();
    }
  });

  it("belongs to the agent that connected it", async () => {
    const dir = home();
    writeFileSync(join(dir, "mcp.cjs"), fakeMCP);
    const agent = await Brain.start({
      time: wallTime,
      name: "test",
      instructions: "",
      llm: fauxLLM().llm,
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
    const tools = agent.core.state.tools;
    expect(await call(tools, "calc__add", { a: 2, b: 3 })).toBe("5");
    await agent.close();
    await fails(call(tools, "calc__add", { a: 2, b: 3 }));
    expect(existsSync(join(dir, "test.jsonl"))).toBe(false);
  });
});
