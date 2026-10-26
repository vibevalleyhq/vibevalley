import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { MemorySourceUpdate } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { layer as agentLayer } from "../agent/agent.ts";
import { Settings } from "../base/config.ts";
import { Database, DbLayer } from "../base/db.ts";
import { Setting, layer as settingLayer } from "../setting/setting.ts";
import { testConfig } from "../testing/layers.ts";
import { foundText, Memories, make } from "./memory.ts";
import { localName } from "./recall.ts";
import { nowledge, nowledgeLabels } from "./nowledge.ts";
import { until } from "../testing/until.ts";

/** How EverOS names a farm project's scope (everos.ts): ASCII, and never the same as global. */
const everosProject = (project: string) => "project-" + createHash("sha256").update(project).digest("hex");

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

const bodyOf = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString("utf8")));
    req.on("end", () => resolve(text ? JSON.parse(text) : undefined));
  });

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

interface NowledgeMemory {
  id: string;
  title: string;
  content: string;
  labels: string[];
}

/**
 * Nowledge Mem played over MCP: memory_search and memory_add as its tools/list gives them (2026-10-18, 0.10.103); any
 * other tool (memory_delete here) must never be called. A search without a query finds nothing; with labels to filter by,
 * any query finds all they hold ("*" here).
 */
class FakeNowledge {
  memories: NowledgeMemory[] = [];
  searches: Record<string, unknown>[] = [];
  adds: Record<string, unknown>[] = [];
  others: string[] = [];
  details: string[] = [];
  searchResult: unknown;
  /** What memory_add answers instead of the memory it made, when set. */
  addResult: unknown;

  private server() {
    const server = new McpServer({ name: "nowledge-mem", version: "0.10.103" }, { capabilities: { tools: {} } });
    const object = { type: "object" as const };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ["memory_search", "memory_add", "get_memory_by_id", "memory_delete"].map((name) => ({ name, inputSchema: object })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const a = req.params.arguments ?? {};
      const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
      switch (req.params.name) {
        case "get_memory_by_id": {
          const id = String(a.memory_id);
          this.details.push(id);
          const memory = this.memories.find((m) => m.id === id);
          return text(memory ?? {});
        }
        case "memory_search": {
          this.searches.push(a);
          if (this.searchResult !== undefined) return text(this.searchResult);
          const query = (a.query as string) ?? "";
          const label = (a.filter_labels as string) ?? "";
          const results = [...this.memories]
            .reverse()
            .filter(
              (m) => (label === "" || m.labels.includes(label)) && query !== "" && (query === "*" || m.content.includes(query) || m.title.includes(query)),
            )
            .map((m) => ({ id: m.id, memory_id: m.id, title: m.title, content: m.content, content_preview: m.content, relevance_score: 0.9 }));
          return text({ results, total: results.length, query });
        }
        case "memory_add": {
          this.adds.push(a);
          if (this.addResult !== undefined) return text(this.addResult);
          const m = { id: `nm-${this.memories.length + 1}`, title: a.title as string, content: a.content as string, labels: (a.labels as string).split(",") };
          this.memories.push(m);
          return text({ id: m.id, title: m.title });
        }
        default:
          this.others.push(req.params.name);
          return text({ deleted: true });
      }
    });
    return server;
  }

  async serve() {
    const url = await listen(
      createServer(async (req, res) => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await this.server().connect(transport);
        await transport.handleRequest(req, res, req.method === "POST" ? await bodyOf(req) : undefined);
      }),
    );
    return url + "/mcp/";
  }
}

interface EverosRequest {
  path: string;
  auth: string;
  body: Record<string, unknown>;
}

/** EverOS's /api/v2 played: every request as it came, and a search that answers with one case and one episode. */
class FakeEveros {
  requests: EverosRequest[] = [];
  searchData: unknown;
  serve() {
    return listen(
      createServer(async (req, res) => {
        const body = ((await bodyOf(req)) ?? {}) as Record<string, unknown>;
        this.requests.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/v2/memory/search") {
          const data =
            body.user_id !== undefined
              ? {
                  episodes: [
                    {
                      id: "ep-1",
                      subject: "登录页",
                      summary: "主人让修登录页，改完了",
                      score: 0.7,
                      app_id: body.app_id ?? "default",
                      project_id: body.project_id ?? "default",
                    },
                  ],
                }
              : {
                  agent_cases: [
                    {
                      id: "case-1",
                      task_intent: "给打卡接口加分页",
                      approach: "先跑 pnpm test",
                      key_insight: "分页参数从 1 开始",
                      score: 0.8,
                      app_id: body.app_id ?? "default",
                      project_id: body.project_id ?? "default",
                    },
                  ],
                };
          res.end(JSON.stringify(this.searchData === undefined ? { request_id: "r1", data } : this.searchData));
        } else if (req.url === "/api/v2/memory/add" || req.url === "/api/v2/memory/flush") res.end(JSON.stringify({ request_id: "r2", data: {} }));
        else res.writeHead(404).end();
      }),
    );
  }
  seen(path: string) {
    return this.requests.filter((r) => r.path === "/api/v2/memory/" + path);
  }
}

const world = (timeoutMs?: number) =>
  Layer.effect(Memories, make(undefined, timeoutMs)).pipe(
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(settingLayer),
    Layer.provideMerge(DbLayer),
    Layer.provideMerge(Database),
    Layer.provideMerge(Layer.succeed(Settings, testConfig())),
  );

const save = (s: MemorySourceUpdate) => Effect.flatMap(Setting, (setting) => setting.save({ memorySources: [s] })).pipe(Effect.orDie);

describe("Nowledge Mem", () => {
  it.live("a project search proves source scope even when reading everything was requested", () =>
    Effect.gen(function* () {
      const fake = new FakeNowledge();
      fake.memories = [
        { id: "a", title: "", content: "测试 project-a", labels: nowledgeLabels("lab", "demo").split(",") },
        { id: "b", title: "", content: "测试 project-b", labels: nowledgeLabels("lab", "other").split(",") },
        { id: "g", title: "", content: "测试 global", labels: nowledgeLabels("lab", "").split(",") },
        { id: "u", title: "", content: "测试 unknown", labels: [] },
      ];
      yield* save({ kind: "nowledge", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: true, write: false, everything: true });
      const m = yield* Memories;
      const q = { agent: "lab", project: "demo", text: "测试", kind: "" as const, limit: 10 };
      const text = foundText(yield* m.search(q), q);
      expect(text).toContain("测试 project-a");
      expect(text).toContain("测试 global");
      expect(text).not.toContain("测试 project-b");
      expect(text).not.toContain("测试 unknown");
      expect(text).toContain("范围");
      expect(fake.details.sort()).toEqual(["a", "b", "g", "u"]);
      const all = { ...q, project: "" };
      expect(foundText(yield* m.search(all), all)).toContain("测试 unknown");
    }).pipe(Effect.provide(world())),
  );

  it.live("a run's notes reach Nowledge and come back", () =>
    Effect.gen(function* () {
      const fake = new FakeNowledge();
      yield* save({ kind: "nowledge", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: true, write: true });
      const m = yield* Memories;
      yield* m.keep({
        agent: "lab",
        session: "w1",
        project: "demo",
        job: "修登录页",
        outcome: "completed",
        summary: "改好了",
        said: "改好了。\n记住：测试前要 export DEEPSEEK_API_KEY=sk-abcdefghijklmnop1234\n记住（所有项目）：提交信息写中文",
      });
      yield* until(() => fake.adds.length === 2);
      expect([fake.adds[0]!.content, fake.adds[0]!.labels, fake.adds[0]!.source_app]).toEqual([
        "测试前要 export DEEPSEEK_API_KEY=[redacted]",
        nowledgeLabels("lab", "demo"),
        "vibevalley",
      ]);
      expect(fake.adds[1]!.labels).toBe(nowledgeLabels("lab", ""));

      const got = yield* m.recall({ agent: "lab", session: "w2", project: "demo", text: "测试" });
      expect(got.ids).toContain("nowledge:nm-1");
      expect(got.lines.some((l) => l.startsWith("- （Nowledge）测试前要"))).toBe(true);
      const last = fake.searches.at(-1)!;
      expect([last.filter_labels, last.query]).toEqual(["vibevalley-agent-lab", "测试"]);

      const both = (yield* m.search({ agent: "lab", project: "", text: "提交", kind: "", limit: 0 })).found;
      expect(both.map((f) => f.source)).toEqual([localName]);
      fake.memories.push({ id: "nm-9", title: "部署", content: "部署用 make deploy", labels: ["vibevalley-agent-lab"] });
      const q = { agent: "lab", project: "", text: "部署", kind: "" as const, limit: 0 };
      const found = yield* m.search(q);
      expect(found.found.map((f) => [f.source, f.id])).toEqual([["nowledge", "nowledge:nm-9"]]);
      expect(foundText(found, q)).toContain("- （Nowledge Mem，项目范围未知）部署用 make deploy〔nowledge:nm-9〕");

      const listed = yield* m.memoriesOf("lab");
      const outside = listed.memories.find((x) => x.source === "nowledge");
      expect(outside).toBeDefined();
      expect([listed.sources.length, listed.sources[1]!.canList, listed.sources[1]!.canForget]).toEqual([2, true, false]);
      expect((yield* Effect.flip(m.forgetOf("lab", outside!.id)))._tag).toBe("Refused");
      expect(fake.others).toEqual([]);
    }).pipe(Effect.provide(world())),
  );

  it.live("Nowledge reads everything only when told, and writes only when told", () =>
    Effect.gen(function* () {
      const fake = new FakeNowledge();
      fake.memories = [{ id: "own-1", title: "主人的偏好", content: "测试要写成可观察的结果", labels: [] }];
      const url = yield* Effect.promise(() => fake.serve());
      yield* save({ kind: "nowledge", url, enabled: true, read: true, write: false });
      const m = yield* Memories;
      const q = { agent: "lab", project: "", text: "测试", kind: "" as const, limit: 0 };
      expect((yield* m.search(q)).found).toEqual([]);
      yield* save({ kind: "nowledge", url, enabled: true, read: true, write: false, everything: true });
      expect((yield* m.search(q)).found.map((f) => f.text)).toEqual(["主人的偏好：测试要写成可观察的结果"]);
      yield* m.write({ agent: "lab", text: "不写进去", project: "", by: "owner" });
      yield* Effect.sleep(50);
      expect(fake.adds).toEqual([]);
    }).pipe(Effect.provide(world())),
  );

  it.live("a Nowledge that does not answer is skipped", () =>
    Effect.gen(function* () {
      const url = yield* Effect.promise(() => listen(createServer(() => {})));
      yield* save({ kind: "nowledge", url, enabled: true, read: true, write: false });
      const m = yield* Memories;
      yield* m.write({ agent: "lab", text: "迁移文件放 db/migrations", project: "demo", by: "owner" });
      const start = Date.now();
      expect((yield* m.recall({ agent: "lab", project: "demo", text: "迁移" })).lines).toHaveLength(1);
      expect(Date.now() - start).toBeLessThan(1000);
    }).pipe(Effect.provide(world(100))),
  );

  it.live("malformed Nowledge responses degrade to no outside memories and can recover", () =>
    Effect.gen(function* () {
      const fake = new FakeNowledge();
      yield* save({ kind: "nowledge", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: true, write: false });
      const m = yield* Memories;
      const q = { agent: "lab", project: "", text: "有效", kind: "" as const, limit: 10 };
      fake.searchResult = { results: {} };
      expect((yield* m.search(q)).found).toEqual([]);
      fake.searchResult = { results: [{ id: 42, content: "bad" }] };
      expect((yield* m.search(q)).found).toEqual([]);
      fake.searchResult = undefined;
      fake.memories = [{ id: "nm-1", title: "有效", content: "有效的记忆", labels: nowledgeLabels("lab", "").split(",") }];
      expect((yield* m.search(q)).found.map((f) => f.id)).toEqual(["nowledge:nm-1"]);
    }).pipe(Effect.provide(world())),
  );
});

describe("EverOS", () => {
  it.live("a memory_add answer that does not read is a failure, while one without an id is a note already there", () =>
    Effect.gen(function* () {
      const fake = new FakeNowledge();
      const source = nowledge({ kind: "nowledge", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: false, write: true });
      const note = { agent: "lab", text: "记住：苹果", project: "", by: "agent" as const };
      fake.addResult = { title: "已经有了" };
      expect((yield* Effect.promise(() => source.add(note, new AbortController().signal)))?.id).toBe("");
      fake.addResult = { id: 42 };
      const failed = yield* Effect.promise(() =>
        source.add(note, new AbortController().signal).then(
          () => "",
          (e: Error) => e.message,
        ),
      );
      expect(failed).toContain("memory_add answered what it should not");
      yield* Effect.promise(() => source.stop());
    }),
  );

  it.live("a project query asks the farm's project and global scopes and does not claim cross-project coverage", () =>
    Effect.gen(function* () {
      const fake = new FakeEveros();
      yield* save({ kind: "everos", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: true, write: false });
      const m = yield* Memories;
      const q = { agent: "lab", project: "demo", text: "分页", kind: "" as const, limit: 10 };
      expect(foundText(yield* m.search(q), q)).toContain("给打卡接口加分页");
      expect(
        fake
          .seen("search")
          .map((r): [string, string] => [String(r.body.app_id), String(r.body.project_id)])
          .sort(([, a], [, b]) => a.localeCompare(b)),
      ).toEqual([
        ["vibevalley", "global"],
        ["vibevalley", everosProject("demo")],
      ]);
      const all = { ...q, project: "" };
      const text = foundText(yield* m.search(all), all);
      expect(text).toContain("EverOS");
      expect(text).toContain("不支持跨项目");
      expect(fake.seen("search")).toHaveLength(2);
    }).pipe(Effect.provide(world())),
  );

  it.live("malformed EverOS responses degrade to no outside memories and can recover", () =>
    Effect.gen(function* () {
      const fake = new FakeEveros();
      yield* save({ kind: "everos", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: true, write: false });
      const m = yield* Memories;
      const q = { agent: "lab", project: "demo", text: "分页", kind: "" as const, limit: 10 };
      fake.searchData = { data: { agent_cases: {} } };
      expect((yield* m.search(q)).found).toEqual([]);
      fake.searchData = { data: { agent_cases: [{ id: 42 }] } };
      expect((yield* m.search(q)).found).toEqual([]);
      fake.searchData = undefined;
      expect((yield* m.search(q)).found.some((f) => f.text.includes("给打卡接口加分页"))).toBe(true);
    }).pipe(Effect.provide(world())),
  );

  it.live("EverOS gets runs and extracts when the session ends", () =>
    Effect.gen(function* () {
      const fake = new FakeEveros();
      yield* save({
        kind: "everos",
        url: (yield* Effect.promise(() => fake.serve())) + "/",
        enabled: true,
        read: true,
        write: true,
        user: "lucas",
        key: "ev-key-1234",
      });
      const m = yield* Memories;
      yield* m.keep({
        agent: "lab",
        session: "w1",
        project: "demo",
        job: "修登录页，token 是 sk-abcdefghijklmnop1234",
        outcome: "completed",
        said: "改好了。\n记住：登录态统一走 refreshSession()",
        summary: "改好了",
      });
      yield* m.keep({ agent: "lab", session: "w1", project: "demo", job: "修登录页", outcome: "failed", said: "测试没过", summary: "测试没过" });
      yield* m.keep({ agent: "lab", session: "w1", project: "demo", job: "修登录页", outcome: "interrupted", said: "停下了", summary: "" });
      yield* until(() => fake.seen("add").length === 2);
      const adds = fake.seen("add");
      expect(adds[0]!.body).toMatchObject({ session_id: "vibevalley-w1", app_id: "vibevalley", project_id: everosProject("demo") });
      expect(adds[0]!.body.messages).toMatchObject([
        { role: "user", sender_id: "lucas", content: "修登录页，token 是 [redacted]" },
        { role: "assistant", sender_id: "vibevalley-lab", content: "改好了。\n记住：登录态统一走 refreshSession()" },
      ]);
      expect(adds[0]!.auth).toBe("Bearer ev-key-1234");
      const second = adds[1]!.body.messages as { role: string; content: string }[];
      expect(second.map((x) => x.role)).not.toContain("user");
      expect(JSON.stringify(second)).toContain("（这一轮没做成）测试没过");
      expect(fake.seen("flush")).toEqual([]);

      yield* m.endSession({ agent: "lab", session: "w1", project: "demo" });
      yield* m.endSession({ agent: "lab", session: "w2", project: "demo" });
      yield* until(() => fake.seen("flush").length === 1);
      yield* Effect.sleep(50);
      const flushes = fake.seen("flush");
      expect(flushes).toHaveLength(1);
      expect([flushes[0]!.body.session_id, flushes[0]!.body.project_id]).toEqual(["vibevalley-w1", everosProject("demo")]);

      const got = yield* m.recall({ agent: "lab", session: "w3", project: "demo", text: "分页" });
      expect(got.ids).toContain(`everos:${everosProject("demo")}:case-1`);
      expect(got.lines).toContain("- （EverOS）给打卡接口加分页；先跑 pnpm test；分页参数从 1 开始");
      const asked = fake.seen("search")[0]!.body;
      expect([asked.agent_id, asked.query, asked.user_id]).toEqual(["vibevalley-lab", "分页", undefined]);
      const found = (yield* m.search({ agent: "lab", project: "demo", text: "登录", kind: "issue", limit: 0 })).found;
      expect(found.some((f) => f.id === `everos:${everosProject("demo")}:ep-1` && f.text === "登录页：主人让修登录页，改完了")).toBe(true);
      expect((yield* m.search({ agent: "", project: "", text: "登录", kind: "", limit: 0 })).found.some((f) => f.source === "everos")).toBe(false);
      const sources = m.sources();
      expect([sources.length, sources[1]!.label, sources[1]!.canList, sources[1]!.canForget, sources[1]!.transcripts]).toEqual([
        2,
        "EverOS",
        false,
        false,
        true,
      ]);
    }).pipe(Effect.provide(world())),
  );

  it.live("a note outside a run is extracted at once", () =>
    Effect.gen(function* () {
      const fake = new FakeEveros();
      yield* save({ kind: "everos", url: yield* Effect.promise(() => fake.serve()), enabled: true, read: true, write: true });
      const m = yield* Memories;
      yield* m.write({ agent: "lab", text: "提交信息写中文", project: "", by: "owner" });
      yield* until(() => fake.seen("flush").length === 1);
      const add = fake.seen("add")[0]!;
      expect(add.body.session_id).toBe(fake.seen("flush")[0]!.body.session_id);
      expect(add.body.messages).toMatchObject([{ role: "user", sender_id: "owner", content: "记住（所有项目）：提交信息写中文" }, {}]);
    }).pipe(Effect.provide(world())),
  );

  it.live("EverOS is told what is left when the farm stops", () =>
    Effect.gen(function* () {
      const fake = new FakeEveros();
      const url = yield* Effect.promise(() => fake.serve());
      yield* Effect.gen(function* () {
        yield* save({ kind: "everos", url, enabled: true, read: false, write: true });
        const m = yield* Memories;
        yield* m.keep({ agent: "lab", session: "w7", project: "demo", job: "写文档", outcome: "completed", said: "写好了", summary: "" });
        yield* until(() => fake.seen("add").length === 1);
      }).pipe(Effect.provide(world()));
      const flushes = fake.seen("flush");
      expect(flushes.map((f) => f.body.session_id)).toEqual(["vibevalley-w7"]);
    }),
  );
});
