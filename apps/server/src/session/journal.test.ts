import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "@vibevalley/testkit/temp";
import { join } from "node:path";
import type { SessionEvent } from "@vibevalley/protocol";
import { afterEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { readJournal, Trajectories } from "./journal.ts";
import { timeHere, wallTime } from "@/base/time.ts";
const open: Trajectories[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

/** What the journals said they could not save. */
const warnings: string[] = [];

const trajectories = (home = tempDir("journal-"), push: (id: string, e: SessionEvent) => void = () => {}) => {
  const t = new Trajectories(home, push, (message) => warnings.push(message), wallTime);
  open.push(t);
  return t;
};

const bash = (text: string, input?: string) => ({ text, action: "run_command" as const, tool: "bash", ...(input ? { input } : {}) });

describe("a session's log", () => {
  it("discards an obsolete event file and writes the current event shape when the session runs again", () => {
    const home = tempDir("journal-");
    const dir = join(home, "events");
    mkdirSync(dir);
    const file = join(dir, "w1.json");
    writeFileSync(file, JSON.stringify([{ seq: 4, time: 1, type: "assistant/message", text: "旧记录" }]));
    const tr = trajectories(home);
    expect(tr.events("w1")).toEqual([]);
    expect(existsSync(file)).toBe(false);
    tr.openLog("w1").said("新的记录");
    tr.finish("w1");
    expect(readJournal(file)).toMatchObject([{ seq: 0, revision: 0, text: "新的记录" }]);
  });

  it("versions a streaming step so a later snapshot cannot be replaced by an earlier live copy", () => {
    const tr = trajectories();
    const j = tr.openLog("versioned");
    j.said("测试");
    const first = j.events()[0]!;
    j.said("通过");
    const grown = j.events()[0]!;
    expect(first).toMatchObject({ seq: 0, revision: 0, text: "测试" });
    expect(grown).toMatchObject({ seq: 0, revision: 1, text: "测试通过" });
    j.toolStarted("c1", bash("读取参数"));
    const call = j.events()[1]!;
    j.toolInput("c1", '{"command":"pwd"}', "pwd");
    expect(j.events()[1]).toMatchObject({ seq: call.seq, revision: 1, input: '{"command":"pwd"}', text: "pwd" });
    tr.finish("versioned");
    expect(tr.events("versioned")![0]).toMatchObject({ seq: 0, revision: 1, text: "测试通过" });
  });

  it("is kept, read back from disk once let go, and taken up again where it was", () => {
    const tr = trajectories();
    const j = tr.openLog("w1");
    j.runStarted("r7");
    j.asked("加分页");
    j.toolStarted("c1", bash("ls"));
    j.toolEnded("c1", "a\nb", true);
    j.runEnded("r7", "completed");
    tr.finish("w1");
    expect(tr.events("w1")!.map((s) => s.type + ":" + (s.output ?? ""))).toEqual(["run/start:", "user/message:", "tool/call:", "tool/result:a\nb", "run/end:"]);
    expect(tr.events("w1")![2]!.actionText).toBe("跑命令");
    expect(tr.events("w1", "r7")).toHaveLength(5);
    expect(tr.events("w1", "r8")).toHaveLength(0);
    expect(tr.events("../w1")).toBeUndefined();
    expect(tr.openLog("w1").events()).toHaveLength(5);
  });

  it("reasoning runs on", () => {
    const j = trajectories().openLog("w1");
    j.thought("先看");
    j.thought("路由");
    j.said("好");
    j.thought("再想想");
    j.toolStarted("c1", bash("ls"));
    j.thought("看完了");
    expect(j.events().map((s) => s.type + ":" + s.text)).toEqual([
      "assistant/thinking:先看路由",
      "assistant/message:好",
      "assistant/thinking:再想想",
      "tool/call:ls",
      "assistant/thinking:看完了",
    ]);
  });

  it("a sub-agent's steps go under their call", () => {
    const j = trajectories().openLog("w1");
    j.toolStarted("task-1", { text: "派个帮手", action: "other", tool: "TaskGraph" });
    j.said("帮手先看看", ["task-1"]);
    j.toolStarted("c1", bash("ls"), ["task-1"]);
    j.toolStarted("c1", bash("pwd"));
    j.toolEnded("c1", "a.ts", true, ["task-1"]);
    j.said("帮手看完了", ["task-1"]);
    j.toolEnded("c1", "/work", true);
    j.toolEnded("task-1", "看完了", true);
    j.said("好");
    j.said("，就这样", ["ghost"]);
    expect(j.events().map((s) => `${s.seq} ${s.type} ${s.text} ${s.output ?? ""} ${s.under ?? "-"} ${s.call ?? "-"}`)).toEqual([
      "0 tool/call 派个帮手  - -",
      "1 assistant/message 帮手先看看  0 -",
      "2 tool/call ls  0 -",
      "3 tool/call pwd  - -",
      "4 tool/result  a.ts 0 2",
      "5 assistant/message 帮手看完了  0 -",
      "6 tool/result  /work - 3",
      "7 tool/result  看完了 - 0",
      "8 assistant/message 好  - -",
      "9 assistant/message ，就这样  -1 -",
    ]);
  });

  it.effect("sends a grown step once, and writes it", () =>
    Effect.gen(function* () {
      const home = tempDir("journal-");
      const pushed: [string, SessionEvent][] = [];
      const tr = new Trajectories(
        home,
        (id, e) => pushed.push([id, e]),
        (message) => warnings.push(message),
        yield* timeHere,
      );
      open.push(tr);
      const j = tr.openLog("w9");
      j.said("好");
      j.said("的");
      yield* TestClock.adjust(400);
      expect(pushed.map(([id, e]) => [id, e.text])).toEqual([["w9", "好的"]]);
      tr.finish("w9");
      expect(readJournal(join(home, "events", "w9.json"))).toHaveLength(1);
    }),
  );

  // On the service's Clock (base/time.ts): the push and save windows are moved, not waited for.
  it.effect("pushes a step 300 ms after it changes and saves 1.5 s after the last change, on the Clock it was given", () =>
    Effect.gen(function* () {
      const pushed: string[] = [];
      const home = tempDir("journal-");
      const file = join(home, "events", "w1.json");
      const tr = new Trajectories(
        home,
        (_, e) => pushed.push(e.text ?? ""),
        (message) => warnings.push(message),
        yield* timeHere,
      );
      open.push(tr);
      const j = tr.openLog("w1");
      j.asked("一");
      yield* TestClock.adjust(299);
      expect(pushed).toEqual([]);
      yield* TestClock.adjust(1);
      expect(pushed).toEqual(["一"]);
      yield* TestClock.adjust(900);
      j.asked("二");
      yield* TestClock.adjust(1_300);
      expect(existsSync(file)).toBe(false);
      yield* TestClock.adjust(200);
      expect(readJournal(file)?.map((e) => e.text)).toEqual(["一", "二"]);
    }),
  );

  it("only grows", () => {
    const home = tempDir("journal-");
    const tr = trajectories(home);
    const file = join(home, "events", "w1.json");
    let j = tr.openLog("w1");
    j.asked("加分页");
    j.toolStarted("c1", bash("ls", `{"cmd":"ls"}`));
    j.said("先看");
    j.said("看目录");
    tr.finish("w1");
    const first = readJournal(file)!;
    expect(first).toHaveLength(3);
    expect(first[2]!.text).toBe("先看看目录");
    j = tr.openLog("w1");
    j.said("还没说完");
    j.note("run/error", "停了");
    tr.finish("w1");
    const after = readJournal(file)!;
    expect(after.slice(0, 3)).toEqual(first);
    expect(after).toHaveLength(5);
  });
});
