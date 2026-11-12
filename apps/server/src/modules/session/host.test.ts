import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer, text, toolCall } from "@vibevalley/ai/testing";
import { collect } from "@vibevalley/async";

import { user } from "#/base/actor.ts";
import builtIn from "#/modules/agent/templates/orchestrator/agent.json" with { type: "json" };
import { testConfig, nextTurn, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as qs from "#db/session.sql.ts";

import { Caller, NotAnswered, SubmitRefused } from "./host.ts";
import type { SessionNews } from "./signals.ts";

const words = async (caller: Caller) => (await collect(caller.words())).join("");
/** Whether p has settled by now. */
const settledBy = async (p: Promise<unknown>) => {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await nextTurn();
  return settled;
};

describe("Caller", () => {
  test("keeps what came before its reader, then streams until it ends", async () => {
    const caller = new Caller();
    caller.push("early ");
    const reading = words(caller);
    caller.push("late");
    caller.end();
    caller.push("after the end");
    const reading2 = await reading;
    expect(reading2).toBe("early late");
  });

  test("fails its reader with what failed it, as the cause", async () => {
    const caller = new Caller();
    caller.push("partly");
    caller.fail(new Error("no model"));
    const read = await words(caller).catch((e: unknown) => e);
    expect(read).toBeInstanceOf(NotAnswered);
    expect(read).toMatchObject({ name: "NotAnswered", message: "no model", cause: new Error("no model") });
  });
  test("ended before its reader, still hands over what it kept, once", async () => {
    const caller = new Caller();
    caller.push("kept");
    caller.end();
    caller.fail(new Error("too late"));
    const mkString2 = await words(caller);
    expect(mkString2).toBe("kept");
    const mkString3 = await words(caller);
    expect(mkString3).toBe("");
  });

  test("failed while streaming, the reader gets the words before the failure", async () => {
    const caller = new Caller();
    const heard: string[] = [];
    const reading = (async () => {
      for await (const w of caller.words()) heard.push(w);
    })();
    caller.push("partly");
    caller.fail(new Error("no model"));
    caller.end();
    const readingFailure = await reading.catch((e: unknown) => e);
    expect(readingFailure).toMatchObject({ name: "NotAnswered", message: "no model" });
    expect(heard).toEqual(["partly"]);
  });
});

describe("AgentHost", () => {
  test("says each answer once, whole, while the caller gets its words as they grow", async () => {
    const config = testConfig();
    await using farm = await world({ config });
    const sessions = farm.session;
    const { llm, requests } = scriptedLLM([
      answer([text("我看一下"), toolCall("remember", { note: "remembered in database" }), toolCall("missing", {})]),
      answer("看完了，一切正常"),
    ]);
    const memory = farm.memory;
    await memory.remember({ agent: "orchestrator", text: "database preference", repo: "", by: user });
    const finished: Extract<SessionNews, { _tag: "RunFinished" }>[] = [];
    const consumed: Extract<SessionNews, { _tag: "Consumed" }>[] = [];
    const answeringRuns: (string | undefined)[] = [];
    using news = sessions.news();
    const followingNews = (async () => {
      for await (const n of news) {
        if (n._tag === "RunFinished") finished.push(n);
        else if (n._tag === "Consumed") consumed.push(n);
      }
    })();
    const said: string[] = [];
    const states: string[] = [];
    const core = farm.core;
    using changes = core.subscribe();
    const followingStates = (async () => {
      for await (const _ of changes) {
        const session = core.session("orchestrator");
        if (!session) continue;
        const phase = session.phase;
        states.push(phase._tag === "working" ? `${phase.doing.action}${session.channel ? " " + session.channel : ""}` : phase._tag);
      }
    })();
    const host = await sessions.host({
      session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", runtime: "vibevalley", brief: "" },
      inputType: "testInput",
      home: config.home,
      cwd: config.workRoot,
      instructions: "",
      llm: () => llm,
      tools: () => [],
      first: "first",
      quiet: () => false,
      say: async (_route, words) => {
        said.push(words);
        answeringRuns.push(sessions.runOf("orchestrator"));
      },
      channel: (route) => route,
      fresh: () => {},
      restored: () => ({ by: { kind: "" } }),
      toolStart: (tool) => ({ text: tool, action: "other", tool }),
    });
    const kept = await qs.sessionByID(farm.db.sql, { id: "orchestrator" });
    expect(kept).toMatchObject({ id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: builtIn.name, ended_at: null });
    const caller = new Caller();
    const heard: string[] = [];
    const reading = (async () => {
      for await (const w of caller.words()) heard.push(w);
    })();
    await host.submit(async () => ({ text: "看看" }), { route: "r", run: { by: { kind: "" }, heard: ["m1"] }, caller }, true);
    await until(() => core.session("orchestrator")?.phase._tag === "done" && said.length === 2, "the run settled");
    await reading;
    expect(said).toEqual(["我看一下", "看完了，一切正常"]);
    await until(() => finished.length === 1 && consumed.length === 1, "the public run events");
    expect(finished).toEqual([{ _tag: "RunFinished", id: expect.any(String), issues: [], outcome: "completed" }]);
    expect(consumed).toEqual([{ _tag: "Consumed", session: "orchestrator", envelopeIds: ["m1"] }]);
    expect(answeringRuns).toEqual([finished[0]!.id, finished[0]!.id]);
    expect(requests[0]!.system).toContain("database preference");
    expect((await memory.list("orchestrator")).some((note) => note.text === "remembered in database")).toBe(true);
    expect(existsSync(join(config.home, "MEMORY.md"))).toBe(false);
    expect(sessions.runOf("orchestrator")).toBeUndefined();
    // A character at a time from the script: more pushes than answers.
    expect(heard.length).toBeGreaterThan(2);
    expect(heard.join("")).toBe("我看一下\n看完了，一切正常\n");
    // Where it works is said once it takes the input, and kept until it is done.
    expect(states).toContain("thinking r");
    expect(states).toContain("speaking_text r");
    expect(core.session("orchestrator")).toMatchObject({ role: "orchestrator", phase: { _tag: "done" }, runs: 1 });
    await host.close();
    news.close();
    changes.close();
    await Promise.all([followingNews, followingStates]);
  });

  test("waits for an input build before closing, without delivering it late", async () => {
    const config = testConfig();
    await using farm = await world({ config });
    const sessions = farm.session;
    const { llm } = scriptedLLM();
    const host = await sessions.host({
      session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", runtime: "vibevalley", brief: "" },
      inputType: "testInput",
      home: config.home,
      cwd: config.workRoot,
      instructions: "",
      llm: () => llm,
      tools: () => [],
      first: "first",
      quiet: () => true,
      say: async () => {},
      channel: () => undefined,
      fresh: () => {},
      restored: () => ({ by: { kind: "" } }),
      toolStart: (tool) => ({ text: tool, action: "other", tool }),
    });
    const building = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const caller = new Caller();
    const submitting = host.submit(
      async () => {
        building.resolve();
        await gate.promise;
        return { text: "late" };
      },
      { route: "late", run: { by: { kind: "" } }, caller },
      true,
    );
    await building.promise;
    const closing = host.close();
    // A close that did not wait for the build would have ended by the next turn.
    expect(await settledBy(closing)).toBe(false);
    gate.resolve();
    const result = await submitting.catch((e: unknown) => e);
    expect(result).toBeInstanceOf(SubmitRefused);
    await closing;
    // Every later close waits for the one close, which is over.
    await host.close();
    expect(host.current().route).toBe("first");
    const mkString2 = await words(caller);
    expect(mkString2).toBe("");
  });
  test("regression: a later close still waits for the cleanup when the first closing caller is interrupted", async () => {
    const config = testConfig();
    await using farm = await world({ config });
    const sessions = farm.session;
    const { llm } = scriptedLLM();
    const host = await sessions.host({
      session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", runtime: "vibevalley", brief: "" },
      inputType: "testInput",
      home: config.home,
      cwd: config.workRoot,
      instructions: "",
      llm: () => llm,
      tools: () => [],
      first: "first",
      quiet: () => true,
      say: async () => {},
      channel: () => undefined,
      fresh: () => {},
      restored: () => ({ by: { kind: "" } }),
      toolStart: (tool) => ({ text: tool, action: "other", tool }),
    });
    const building = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    try {
      const submitting = host.submit(
        async () => {
          building.resolve();
          await gate.promise;
          return { text: "late" };
        },
        { route: "late", run: { by: { kind: "" } } },
        true,
      );
      await building.promise;
      const interrupted = new AbortController();
      const first = host.close(interrupted.signal);
      interrupted.abort();
      await first.catch(() => undefined);
      const second = host.close();
      expect(await settledBy(second)).toBe(false);
      gate.resolve();
      expect(await submitting.catch((e: unknown) => e)).toBeInstanceOf(SubmitRefused);
      await second;
    } finally {
      gate.resolve();
    }
  });
});
