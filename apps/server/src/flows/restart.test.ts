import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Event } from "@botiverse/oar";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { expect, test } from "vite-plus/test";

import { TaskGroup } from "@vibevalley/async";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { keptLog } from "#/infra/log.ts";
import { makeOrchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { entryMessage, messageText } from "#/modules/runtime/durable.ts";
import { helperInstructions, helperKey, vibevalleyRuntimeOf } from "#/modules/runtime/vibevalley.ts";
import { testConfig } from "#/testing/layers.ts";
import { answer, lastUser, type Request, scriptedLLM, type Step } from "#/testing/model.ts";
import { sqlOf } from "#/testing/sql.ts";
import { type World, world } from "#/testing/world.ts";

import { await_, until } from "./farm.ts";

const words = "地里都好，三块地在长";

/** What the assistant said in the farm's default channel. */
const said = (farm: World) => () =>
  farm.said
    .in(farm.channel.defaultChannel())
    .filter((m) => m.from === defaultOrchestrator && m.kind === "chat")
    .map((m) => m.text);

test("the assistant cut off mid-answer by a restart finishes it once the farm is back, as one run", async () => {
  const config = testConfig({ db: "", patrol: { heartbeatMinutes: 0 } });
  /** The farm as services.ts builds it: the orchestrator made before the sessions come back. */
  const open = async (llm: ReturnType<typeof scriptedLLM>["llm"]) => {
    const below = await world({ config });
    try {
      below.deepseek.use(llm);
      const orchestrator = await makeOrchestrator(below);
      below.closes.push(() => orchestrator.close());
      await below.session.boot();
      await below.mailbox.boot();
      return below;
    } catch (e) {
      await below.close();
      throw e;
    }
  };

  const before = scriptedLLM([answer(words, { hangAfter: 3 })]);
  {
    await using farm = await open(before.llm);
    await farm.channel.say("地里怎么样", {}, undefined, "");
    // The answer has begun to show: the model is in the middle of it when the farm stops.
    await until(() => {
      const phase = farm.core.session(defaultOrchestrator)?.phase;
      return phase?._tag === "working" && phase.doing.action === "speaking_text";
    }, "the answer under way");
    expect(said(farm)()).toEqual([]);
  }
  expect(existsSync(join(config.home, "durable.db"))).toBe(true);

  const after = scriptedLLM([answer(words)]);
  await using farm = await open(after.llm);
  await until(() => said(farm)().length > 0, "the answer after the restart");
  const sql = sqlOf(farm.db);
  const ran = await await_(
    () => sql<{ outcome: string | null }>`select outcome from session_run where session = ${defaultOrchestrator}`,
    (rows) => rows.every((r) => r.outcome !== null),
    "the run ended",
  );
  // Asked again once, said once, recorded once: the run the input started is the one that ended.
  expect(after.requests).toHaveLength(1);
  expect(after.requests[0]!.messages.at(-1)).toMatchObject({ role: "user" });
  expect(said(farm)()).toEqual([words]);
  expect(ran).toEqual([{ outcome: "completed" }]);
  const events = (await farm.session.events(defaultOrchestrator)) ?? [];
  expect(events.filter((e) => e.type === "run/end")).toHaveLength(1);
  expect(events.filter((e) => e.type === "user/message")).toHaveLength(1);
});

test("regression: the assistant and a helper both cut off mid-answer go on once the farm is back, neither without its model", async () => {
  const config = testConfig({ db: "", patrol: { heartbeatMinutes: 0 } });
  const helperWords = "数过了，三块地";
  const helperAsk = "数一下地";
  const helperCwd = tempDir("vibevalley-helper-");
  /** One model for the whole farm, as DeepSeek is: the helper's request and the assistant's each get their own answer. */
  const both =
    (hang: boolean): Step =>
    (r) =>
      lastUser(r).includes(helperAsk) ? answer(helperWords, hang ? { hangAfter: 3 } : {}) : answer(words, hang ? { hangAfter: 3 } : {});
  /** What the model was asked, from the newest farm opened. */
  let asked: Request[] = [];
  const open = async (steps: readonly Step[]) => {
    const below = await world({ config });
    try {
      const script = scriptedLLM(steps);
      asked = script.requests;
      below.deepseek.use(script.llm);
      const orchestrator = await makeOrchestrator(below);
      below.closes.push(() => orchestrator.close());
      await below.session.boot();
      await below.mailbox.boot();
      return below;
    } catch (e) {
      await below.close();
      throw e;
    }
  };

  // The helper's session is the farm's own runtime on the farm's harness, as runtime.ts makes it; never let go before
  // the farm stops, as a crash leaves it.
  const owner = new TaskGroup({ name: "the helper's session" });
  let helper = "";
  try {
    await using farm = await open([both(true), both(true)]);
    const runtime = vibevalleyRuntimeOf({ durable: farm.runtime.durable, helpers: farm.runtime.helpers, owner, log: keptLog() });
    const session = await runtime.session(
      { kind: "available", via: "bundled" },
      { cwd: helperCwd, appendSystemPrompt: "你是后端老周。", env: { FARM_TOKEN: "t0k" } },
    );
    helper = session.id;
    const told: Event[] = [];
    session.events((e) => told.push(e), { cursor: { sessionId: session.id, afterSeq: -1 } });
    await session.prompt(helperAsk);
    await farm.channel.say("地里怎么样", {}, undefined, "");
    await until(() => told.some((e) => e.kind === "text_delta"), "the helper's answer under way");
    await until(() => {
      const phase = farm.core.session(defaultOrchestrator)?.phase;
      return phase?._tag === "working" && phase.doing.action === "speaking_text";
    }, "the assistant's answer under way");
  } finally {
    await owner.close();
  }

  // Back: the assistant's restart runs every conversation left mid-answer, the helper's too, before its session is
  // opened again.
  await using farm = await open([both(false), both(false)]);
  const durable = farm.runtime.durable;
  await until(() => said(farm)().length > 0, "the assistant's answer after the restart");
  expect(said(farm)()).toEqual([words]);
  const conversation = await durable.existing(helperKey(helper));
  if (!conversation) throw new Error("the helper's conversation is not in durable.db");
  await until(async () => !(await durable.busy(helperKey(helper))), "the helper's run ended");
  const live = await durable.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
  expect(live?.runFailure).toBeUndefined();
  const last = (await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0];
  const m = last === undefined ? undefined : entryMessage(last);
  expect(m?.role === "assistant" ? messageText(m) : "").toBe(helperWords);
  // Asked again before its session opened: with its own prompt and tools, as the session gave them.
  const again = asked.find((r) => lastUser(r).includes(helperAsk));
  if (!again) throw new Error("the helper's run was not asked again");
  expect(again.system.startsWith(helperInstructions())).toBe(true);
  expect(again.system).toContain("你是后端老周。");
  expect(again.system).toContain(helperCwd);
  expect(again.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "todo_add", "load_skill", "spawn_agent"]));
});
