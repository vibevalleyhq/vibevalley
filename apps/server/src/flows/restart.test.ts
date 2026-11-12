import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { makeOrchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { agentSessionsBoot, mailboxBoot } from "#/services.ts";
import { testConfig } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";
import { world } from "#/testing/world.ts";

import { await_, until } from "./farm.ts";

const words = "地里都好，三块地在长";

test("the assistant cut off mid-answer by a restart finishes it once the farm is back, as one run", async () => {
  const config = testConfig({ db: "", patrol: { heartbeatMinutes: 0 } });
  /** The farm as services.ts builds it: the orchestrator made before the sessions come back. */
  const open = async (llm: ReturnType<typeof scriptedLLM>["llm"]) => {
    const below = await world({ config });
    try {
      const orchestrator = await makeOrchestrator(below, { llm: () => llm });
      below.closes.push(() => orchestrator.close());
      await agentSessionsBoot(below);
      await mailboxBoot(below);
      return below;
    } catch (e) {
      await below.close();
      throw e;
    }
  };
  const said = (farm: Awaited<ReturnType<typeof open>>) => () =>
    farm.said
      .in(farm.channel.defaultChannel())
      .filter((m) => m.from === defaultOrchestrator && m.kind === "chat")
      .map((m) => m.text);

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
