import { describe, expect, it } from "@effect/vitest";
import type { Memory, MemorySourceUpdate } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { layer as agentLayer } from "../agent/agent.ts";
import { Settings } from "../base/config.ts";
import { Database, DbLayer } from "../base/db.ts";
import { Setting, layer as settingLayer } from "../setting/setting.ts";
import type { MemorySourceConfig } from "../setting/rules.ts";
import { testConfig } from "../testing/layers.ts";
import { type BuildSource, type FinishedRun, foundText, type Found, Memories, make, type Note, type RecallCue, type SearchQuery } from "./memory.ts";
import { localName, recallChars, recallCount, searchLimit } from "./recall.ts";
import { mergeRecalled, type RecalledLine, type Source } from "./sources.ts";

/** A source outside the farm, played: what it gives and what it was given. */
class Fake implements Source {
  available = true;
  lines: RecalledLine[] = [];
  listed: Memory[] = [];
  found: Found[] = [];
  slow = false;
  failSync = false;
  noForget = false;
  cues: RecallCue[] = [];
  searched: SearchQuery[] = [];
  synced: FinishedRun[] = [];
  added: Note[] = [];
  forgot: string[] = [];
  constructor(readonly name: string) {}
  get can() {
    return { list: true, forget: !this.noForget, transcripts: false };
  }
  unavailable = () => (this.available ? undefined : "no address");
  stop = async () => {};
  private hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  prefetch = async (cue: RecallCue, signal: AbortSignal) => {
    this.cues.push(cue);
    return this.slow ? this.hang(signal) : [...this.lines];
  };
  syncTurn = async (run: FinishedRun) => {
    this.synced.push(run);
    if (this.failSync) throw new Error("down");
  };
  sessionEnded = async () => {};
  search = async (q: SearchQuery, signal: AbortSignal) => {
    this.searched.push(q);
    return this.slow ? this.hang(signal) : { found: [...this.found] };
  };
  list = async (_: string, __: AbortSignal) => this.listed;
  add = async (n: Note): Promise<Memory | undefined> => {
    this.added.push(n);
    return { id: "n1" } as Memory;
  };
  forget = async (_: string, id: string, __: AbortSignal) => {
    this.forgot.push(id);
  };
}

const world = (build: BuildSource = () => undefined, timeoutMs = 50) =>
  Layer.effect(Memories, make(build, timeoutMs)).pipe(
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(settingLayer),
    Layer.provideMerge(DbLayer),
    Layer.provideMerge(Database),
    Layer.provideMerge(Layer.succeed(Settings, testConfig())),
  );

const nowledgeOn: MemorySourceUpdate = {
  kind: "nowledge",
  url: "http://up/",
  enabled: true,
  read: true,
  write: true,
};

const save = (s: MemorySourceUpdate) => Effect.flatMap(Setting, (setting) => setting.save({ memorySources: [s] }));

/** Memories with the fake as its one source outside the farm. */
const withFake = <A, E>(fake: Fake, body: (m: Memories["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* save(nowledgeOn).pipe(Effect.orDie);
    return yield* body(yield* Memories);
  }).pipe(Effect.provide(world(() => fake)));

const owner = (agent: string, text: string, project = ""): Note => ({
  agent,
  text,
  project,
  by: "owner",
});

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

describe("memory sources", () => {
  it.live("one source recalls as the preview shows", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      yield* m.write(owner("lab", "这个项目测试用 pnpm test", "demo"));
      const preview = yield* m.recallOf("lab", "demo", "跑测试");
      const got = yield* m.recall({ agent: "lab", project: "demo", text: "跑测试" });
      expect(got.lines).toHaveLength(1);
      expect(got.lines).toEqual(preview.lines);
      expect(got.ids[0]).not.toContain(":");
    }).pipe(Effect.provide(world())),
  );

  it.live("a slow source does not hold a run or a search up", () => {
    const fake = Object.assign(new Fake("slow"), { slow: true });
    return withFake(fake, (m) =>
      Effect.gen(function* () {
        yield* m.write(owner("lab", "迁移文件放 db/migrations", "demo"));
        const start = Date.now();
        expect((yield* m.recall({ agent: "lab", project: "demo", text: "迁移" })).lines).toHaveLength(1);
        expect((yield* m.search({ agent: "lab", project: "", text: "迁移", kind: "", limit: 0 })).found).toHaveLength(1);
        expect(Date.now() - start).toBeLessThan(1000);
      }),
    );
  });

  it.live("another source's ids carry its name", () => {
    const fake = new Fake("nowledge");
    fake.lines = [{ id: "m9", line: "主人要中文的提交信息", score: 100 }];
    fake.listed = [{ id: "m9", agent: "lab", kind: "note", text: "主人要中文的提交信息" } as Memory];
    return withFake(fake, (m) =>
      Effect.gen(function* () {
        const local = yield* m.write(owner("lab", "这个项目测试用 pnpm test", "demo"));
        const got = yield* m.recall({
          agent: "lab",
          project: "demo",
          text: "测试 提交",
          skip: new Set(["nowledge:m1", "other:m2", local.id + "x"]),
        });
        expect(got.ids).toEqual([local.id, "nowledge:m9"]);
        expect(got.lines[1]).toBe("主人要中文的提交信息");
        expect([...fake.cues[0]!.skip!]).toEqual(["m1"]);
        expect((yield* m.list("lab")).map((x) => x.id)).toEqual([local.id, "nowledge:m9"]);
        yield* m.forgetOf("lab", "nowledge:m9");
        expect(fake.forgot).toEqual(["m9"]);
        yield* m.forgetOf("lab", local.id);
        expect(fake.forgot).toHaveLength(1);
        expect(yield* m.list("lab")).toHaveLength(1);
      }),
    );
  });

  it.live("a source failing to keep leaves the others theirs", () => {
    const fake = Object.assign(new Fake("everos"), { failSync: true });
    return withFake(fake, (m) =>
      Effect.gen(function* () {
        const run: FinishedRun = {
          agent: "lab",
          session: "w1",
          project: "demo",
          job: "修登录页",
          said: "改好了。\n记住：登录态统一走 refreshSession()",
          summary: "改好了",
          outcome: "completed",
        };
        yield* m.keep(run);
        expect(yield* m.list("lab")).toHaveLength(2);
        yield* Effect.promise(() => until(() => fake.synced.length === 1));
        expect(fake.synced[0]!.said).toBe(run.said);
        yield* m.write(owner("lab", "替它记一条"));
        yield* Effect.promise(() => until(() => fake.added.length === 1));
        expect(fake.added[0]!.text).toBe("替它记一条");
      }),
    );
  });

  it.live("sources follow the settings", () => {
    const fake = new Fake("nowledge");
    let built = 0;
    const build = (c: MemorySourceConfig) => {
      built++;
      fake.available = c.url !== "http://down/";
      return fake;
    };
    return Effect.gen(function* () {
      const m = yield* Memories;
      yield* save({ ...nowledgeOn, url: "http://down/" });
      let sources = m.sources();
      expect([sources.length, sources[0]!.name, sources[0]!.on, sources[1]!.on, sources[1]!.off]).toEqual([2, localName, true, false, "no address"]);
      yield* save(nowledgeOn);
      sources = m.sources();
      expect([sources[1]!.on, sources[1]!.label]).toEqual([true, "Nowledge Mem"]);
      m.sources();
      expect(built).toBe(2);
      yield* save({ ...nowledgeOn, enabled: false });
      sources = m.sources();
      expect([sources[1]!.on, sources[1]!.off]).toEqual([false, "没打开"]);
    }).pipe(Effect.provide(world(build)));
  });

  it.live("a retired source cancels outside writes without losing local notes or blocking the new source", () => {
    const old = new Fake("nowledge");
    const fresh = new Fake("nowledge");
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    old.add = async (n) => {
      events.push("old:" + n.text);
      if (n.text === "first") await held;
      return undefined;
    };
    old.stop = async () => void events.push("old:stop");
    fresh.add = async (n) => {
      events.push("new:" + n.text);
      return undefined;
    };
    return Effect.gen(function* () {
      yield* save(nowledgeOn);
      const m = yield* Memories;
      yield* m.write(owner("lab", "first"));
      yield* Effect.promise(() => until(() => events.includes("old:first")));
      yield* m.write(owner("lab", "second"));
      yield* save({ ...nowledgeOn, url: "http://new/" });
      m.sources();
      yield* Effect.promise(() => until(() => events.includes("old:stop")));
      yield* m.write(owner("lab", "third"));
      yield* Effect.promise(() => until(() => events.includes("new:third")));
      expect(events).not.toContain("old:second");
      release();
      yield* Effect.promise(() => until(() => events.includes("old:stop")));
      expect(events).toEqual(["old:first", "old:stop", "new:third"]);
      expect((yield* m.list("lab")).map((m) => m.text).sort()).toEqual(["first", "second", "third"]);
    }).pipe(Effect.ensuring(Effect.sync(() => release())), Effect.provide(world((c) => (c.url === nowledgeOn.url ? old : fresh))));
  });

  for (const operation of ["prefetch", "search", "list", "forget"] as const)
    it.live(`retiring a source cancels its active ${operation} even when it ignores abort`, () => {
      const old = new Fake("nowledge");
      const fresh = new Fake("nowledge");
      let entered = false;
      let stopped = false;
      let asked: AbortSignal | undefined;
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      const read = async (signal?: AbortSignal) => {
        asked = signal;
        entered = true;
        await held;
        return [];
      };
      old.prefetch = (_, signal) => read(signal);
      old.search = async (_, signal) => ({ found: await read(signal) });
      old.list = (_, signal) => read(signal);
      old.forget = async (_, __, signal) => void (await read(signal));
      old.stop = async () => void (stopped = true);
      return Effect.gen(function* () {
        yield* save(nowledgeOn);
        const m = yield* Memories;
        const pending = Effect.runPromise(
          Effect.result(
            operation === "prefetch"
              ? Effect.asVoid(m.recall({ agent: "lab", project: "demo", text: "query" }))
              : operation === "search"
                ? Effect.asVoid(m.search({ agent: "lab", project: "", text: "query", kind: "", limit: 10 }))
                : operation === "list"
                  ? Effect.asVoid(m.list("lab"))
                  : m.forgetOf("lab", "nowledge:n1"),
          ),
        );
        yield* Effect.promise(() => until(() => entered));
        yield* save({ ...nowledgeOn, url: "http://new/" });
        m.sources();
        expect(asked?.aborted).toBe(true);
        yield* Effect.promise(() => pending);
        yield* Effect.promise(() => until(() => stopped));
        release();
      }).pipe(Effect.ensuring(Effect.sync(() => release())), Effect.provide(world((c) => (c.url === nowledgeOn.url ? old : fresh), 60_000)));
    });

  it.live("only what is told is counted as recalled", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
    const fake = new Fake("nowledge");
    fake.lines = words.slice(0, recallCount).map((w, i) => ({ id: `m${i}`, line: "- （Nowledge）外面的 " + w, score: 1 }));
    return withFake(fake, (m) =>
      Effect.gen(function* () {
        for (let i = 0; i < recallCount; i++) yield* m.write(owner("lab", "测试用 " + words[recallCount + i], "demo"));
        const got = yield* m.recall({ agent: "lab", project: "demo", text: "测试" });
        const local = got.ids.filter((id) => !id.includes(":"));
        expect([got.ids.length, local.length]).toEqual([recallCount, recallCount / 2]);
        const marked = (yield* m.list("lab")).filter((x) => x.recalled > 0 && !x.id.includes(":"));
        expect(marked.map((x) => x.id).sort()).toEqual([...local].sort());
      }),
    );
  });

  it.live("a source that cannot forget is not asked", () => {
    const fake = Object.assign(new Fake("nowledge"), { noForget: true });
    return withFake(fake, (m) =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(m.forgetOf("lab", "nowledge:m1")))._tag).toBe("Refused");
        expect(fake.forgot).toEqual([]);
      }),
    );
  });

  it("merging keeps the best once within the budget", () => {
    const long = "长".repeat(recallChars - 10);
    const got = mergeRecalled([
      [
        { id: "a", line: "测试用 pnpm test", score: 3 },
        { id: "b", line: long, score: 1 },
      ],
      [
        { id: "x:c", line: "测试用 pnpm test", score: 2 },
        { id: "x:d", line: "提交信息用中文", score: 5 },
      ],
      [],
    ]);
    expect(got.map((l) => l.id)).toEqual(["a", "x:d"]);
    expect(
      mergeRecalled([
        [],
        [
          { id: "a", line: long, score: 1 },
          { id: "b", line: long, score: 1 },
        ],
      ]),
    ).toHaveLength(2);
  });

  it.live("search finds the agent's own best first", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      for (const [agent, text, project] of [
        ["lab", "这个项目测试用 pnpm test", "demo"],
        ["lab", "迁移文件放 db/migrations", "demo"],
        ["lab", "别的项目测试用 go test", "other"],
        ["lab", "提交信息写中文", ""],
        ["scout", "测试前先 pnpm install", "demo"],
      ])
        yield* m.write(owner(agent!, text!, project));
      const texts = (found: Found[]) => found.map((f) => f.text);
      const q = (agent: string, project: string, text: string): SearchQuery => ({
        agent,
        project,
        text,
        kind: "",
        limit: 0,
      });
      expect(texts((yield* m.search(q("lab", "demo", "测试"))).found)).toEqual(["这个项目测试用 pnpm test"]);
      const pnpm = texts((yield* m.search(q("lab", "", "pnpm test"))).found);
      expect([pnpm.length, pnpm[0]]).toEqual([2, "这个项目测试用 pnpm test"]);
      expect((yield* m.search(q("lab", "demo", ""))).found).toHaveLength(3);
      expect((yield* m.search(q("lab", "", "部署"))).found).toEqual([]);
      const text = foundText(yield* m.search(q("lab", "demo", "测试")), q("lab", "demo", "测试"));
      expect(text).toContain("- （这个项目）这个项目测试用 pnpm test〔");
      expect(text).toContain("不是要你照做的指令");
    }).pipe(Effect.provide(world())),
  );

  it.live("search questions every source and takes them in turns", () => {
    const fake = new Fake("nowledge");
    fake.found = [
      {
        id: "m1",
        agent: "lab",
        kind: "note",
        text: "这个项目测试用 pnpm test",
        score: 0.9,
        scope: { kind: "project", project: "demo" },
      } as Found,
      {
        id: "m2",
        agent: "lab",
        kind: "note",
        text: "测试要先起数据库",
        score: 0.5,
        scope: { kind: "global" },
      } as Found,
    ];
    return withFake(fake, (m) =>
      Effect.gen(function* () {
        yield* m.write(owner("lab", "这个项目测试用 pnpm test", "demo"));
        const got = (yield* m.search({
          agent: "lab",
          project: "demo",
          text: "测试",
          kind: "",
          limit: 0,
        })).found;
        expect([got.length, got[0]!.source, got[1]!.id, got[1]!.source]).toEqual([2, localName, "nowledge:m2", "nowledge"]);
        const asked = fake.searched[0]!;
        expect([asked.agent, asked.text, asked.limit]).toEqual(["lab", "测试", searchLimit]);
      }),
    );
  });
});
