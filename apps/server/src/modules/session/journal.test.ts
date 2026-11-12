import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { SessionEvent } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";
import { waitFor } from "@vibevalley/testkit/until";

import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";

import { makeTrajectories, readJournal } from "./journal.ts";

const trajectories = (home = tempDir("journal-"), push: (id: string, e: SessionEvent) => void = () => {}) =>
  makeTrajectories(home, push, { clock: wallTime, log: keptLog() });
const read = async (file: string) => (await readJournal(file)) ?? [];
const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

afterEach(() => {
  vi.useRealTimers();
});

const bash = (text: string, input?: string) => ({ text, action: "run_command" as const, tool: "bash", ...(input ? { input } : {}) });

describe("a session's log", () => {
  test("discards an obsolete event file and writes the current event shape when the session runs again", async () => {
    const home = tempDir("journal-");
    const dir = join(home, "events");
    mkdirSync(dir);
    const file = join(dir, "w1.json");
    writeFileSync(file, JSON.stringify([{ seq: 4, time: 1, type: "assistant/message", text: "旧记录" }]));
    const tr = trajectories(home);
    const events2 = await tr.events("w1");
    expect(events2).toEqual([]);
    expect(existsSync(file)).toBe(false);
    (await tr.openLog("w1")).said("新的记录");
    await tr.finish("w1");
    const content = await read(file);
    expect(content).toMatchObject([{ seq: 0, revision: 0, text: "新的记录" }]);
  });

  test("versions a streaming step so a later snapshot cannot be replaced by an earlier live copy", async () => {
    const tr = trajectories();
    const j = await tr.openLog("versioned");
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
    await tr.finish("versioned");
    expect((await tr.events("versioned"))![0]).toMatchObject({ seq: 0, revision: 1, text: "测试通过" });
  });

  test("is kept, read back from disk once let go, and taken up again where it was", async () => {
    const tr = trajectories();
    const j = await tr.openLog("w1");
    j.runStarted("r7");
    j.asked("加分页");
    j.toolStarted("c1", bash("ls"));
    j.toolEnded("c1", "a\nb", true);
    j.runEnded("r7", "completed");
    await tr.finish("w1");
    const kept = (await tr.events("w1"))!;
    expect(kept.map((s) => s.type + ":" + (s.output ?? ""))).toEqual(["run/start:", "user/message:", "tool/call:", "tool/result:a\nb", "run/end:"]);
    expect(kept[2]!.actionText).toBe("跑命令");
    const events2 = await tr.events("w1", "r7");
    expect(events2).toHaveLength(5);
    const events3 = await tr.events("w1", "r8");
    expect(events3).toHaveLength(0);
    const events4 = await tr.events("../w1");
    expect(events4).toBeUndefined();
    expect((await tr.openLog("w1")).events()).toHaveLength(5);
  });

  test("reasoning runs on", async () => {
    const j = await trajectories().openLog("w1");
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

  test("a sub-agent's steps go under their call", async () => {
    const j = await trajectories().openLog("w1");
    j.toolStarted("task-1", { text: "派个帮手", action: "other", tool: "Task" });
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

  test("sends a grown step once, and writes it", async () => {
    const home = tempDir("journal-");
    const pushed: [string, SessionEvent][] = [];
    fakeTime();
    const tr = trajectories(home, (id, e) => pushed.push([id, e]));
    const j = await tr.openLog("w9");
    j.said("好");
    j.said("的");
    await vi.advanceTimersByTimeAsync(400);
    expect(pushed.map(([id, e]) => [id, e.text])).toEqual([["w9", "好的"]]);
    await tr.finish("w9");
    const content = await read(join(home, "events", "w9.json"));
    expect(content).toHaveLength(1);
  });

  // On fake timers under the service's Clock (infra/time.ts): the push and save windows are moved, not waited for.
  test("pushes a step 300 ms after it changes and saves 1.5 s after the first change, the later ones joining it", async () => {
    const pushed: string[] = [];
    const home = tempDir("journal-");
    const file = join(home, "events", "w1.json");
    fakeTime();
    const tr = trajectories(home, (_, e) => pushed.push(e.text));
    const j = await tr.openLog("w1");
    j.asked("一");
    await vi.advanceTimersByTimeAsync(299);
    expect(pushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pushed).toEqual(["一"]);
    await vi.advanceTimersByTimeAsync(900);
    j.asked("二");
    await vi.advanceTimersByTimeAsync(299);
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const kept = await waitFor(
      () => read(file),
      (events) => events.length > 0,
      "the log written",
    );
    expect(kept.map((e) => e.text)).toEqual(["一", "二"]);
  });

  test("only grows", async () => {
    const home = tempDir("journal-");
    const tr = trajectories(home);
    const file = join(home, "events", "w1.json");
    let j = await tr.openLog("w1");
    j.asked("加分页");
    j.toolStarted("c1", bash("ls", `{"cmd":"ls"}`));
    j.said("先看");
    j.said("看目录");
    await tr.finish("w1");
    const first = await read(file);
    expect(first).toHaveLength(3);
    expect(first[2]!.text).toBe("先看看目录");
    j = await tr.openLog("w1");
    j.said("还没说完");
    j.note("run/error", "停了");
    await tr.finish("w1");
    const after = await read(file);
    expect(after.slice(0, 3)).toEqual(first);
    expect(after).toHaveLength(5);
  });

  test("a log still open when the service closes is sealed and written", async () => {
    const home = tempDir("journal-");
    const file = join(home, "events", "w2.json");
    const tr = trajectories(home);
    const j = await tr.openLog("w2");
    j.said("还在说");
    await tr.close();
    expect((await read(file)).map((e) => e.text)).toEqual(["还在说"]);
  });
});
