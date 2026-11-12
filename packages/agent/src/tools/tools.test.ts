import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { ToolFailed } from "../core/errors.ts";
import { coerceArguments, objectSchema } from "../core/schema.ts";
import { runTool, type Tool } from "../core/tool.ts";
import { readMcpConfig, connectAll, mcpContentText, mcpToolName } from "../infra/mcp.ts";
import { forgetLine, readMemory } from "./memory.ts";
import { selfTools } from "./self.ts";
import { frontMatter, readSkill, scanSkills, skillBody } from "./skills.ts";
import { memoryStore } from "./todoStore.ts";
import { todoTools } from "./todoTools.ts";

const homes: (() => void)[] = [];
const home = () => {
  const dir = tempDir("vibevalley-agent-");
  homes.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

/** As a conversation calls it: the arguments as models get them wrong mended first. */
const call = async (tools: readonly Tool[], name: string, params: unknown): Promise<string> => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name}`);
  const result = await tool.execute(coerceArguments(params, tool.parameters), { id: "t" });
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
/** What a call rejects with. */
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("the task tools", () => {
  test("task and mark the agent's own todos", async () => {
    const tools = todoTools(memoryStore(), async () => undefined);
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

describe("a tool whose work takes a signal", () => {
  test("is interrupted when the run stops", async () => {
    let interrupted = false;
    const waits = runTool({
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
    const refuses = runTool({
      name: "refuses",
      description: "",
      parameters: objectSchema(),
      run: () => Promise.reject(new ToolFailed("不行")),
    });
    const fails2 = await fails(call([refuses], "refuses", {}));
    expect(fails2).toBe("不行");
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

  test("remember and rewrite", async () => {
    const dir = home();
    const tools = selfTools({ now: Date.now, home: dir, skills: async () => [], memory: true });
    const memory = () => readMemory(dir);
    await call(tools, "remember", { note: "用户喜欢\n简短的回答" });
    expect((await memory()).prompt).toMatch(/^- \d{4}-\d\d-\d\d 用户喜欢 简短的回答$/u);
    await call(tools, "rewrite_memory", { content: "- 只说中文" });
    expect((await memory()).prompt).toBe("- 只说中文");
    expect(selfTools({ now: Date.now, home: dir, skills: async () => [], memory: false }).map((t) => t.name)).toEqual(["load_skill"]);
    const lines = (await memory()).lines;
    expect(lines.map((l) => l.text)).toEqual(["只说中文"]);
    await forgetLine(dir, lines[0]!.id);
    expect((await memory()).lines).toEqual([]);
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
});
