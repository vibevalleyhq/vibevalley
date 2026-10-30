// The orchestrator's evals on the real model, and so never in the default run: VIBEVALLEY_EVALS_LIVE=1 with DEEPSEEK_API_KEY
// (vp run evals in apps/server), and it costs money. Each case is sampled VIBEVALLEY_EVAL_N times (5) and passes when all but one of them
// do; VIBEVALLEY_EVALS adds a folder of cases (a home's orchestrator/evals), VIBEVALLEY_EVAL_MODEL another model, and
// VIBEVALLEY_EVAL_ONLY (names, comma-separated) replays only those cases: after a prompt is mended for one, only it is paid for.

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { openBrain, standaloneOwner } from "@vibevalley/agent/brain";
import type { Tool } from "@vibevalley/agent/core/loop";
import { memoryFile } from "@vibevalley/agent/memory";
import { type BrainMessage, transcript } from "@vibevalley/agent/messages";
import { deepseek } from "@vibevalley/ai/client";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { orchestrator } from "@/base/actor.ts";
import { standaloneLlm } from "@/cli/llm.ts";
import { world } from "@/testing/world.ts";
import { Tools } from "@/tool/tool.ts";

import { casesIn, check, committed, type EvalCase, isInput, stubbed } from "./evals.ts";
import { agentPrompt, systemPrompt } from "./prompts.ts";

const live = process.env.VIBEVALLEY_EVALS_LIVE === "1";
const key = process.env.DEEPSEEK_API_KEY ?? "";

/** The orchestrator's tool definitions, from a farm that is let go at once: every call is answered by stubs. */
const orchestratorTools = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* Tools;
        return t.orchestrator(() => ({ agent: defaultOrchestrator, session: "", project: "", here: "", picked: "", actor: orchestrator(true) }));
      }).pipe(Effect.provide(world())),
    ),
  );

/** One sample: the brain as the orchestrator makes it, with the case's memory and channel; the turn the input begins, and
 * the tokens it took. */
async function replay(c: EvalCase, model: string, tools: readonly Tool[]): Promise<{ turn: BrainMessage[]; tokens: number }> {
  const home = tempDir("vibevalley-eval-");
  writeFileSync(memoryFile(home), c.memory);
  writeFileSync(join(home, defaultOrchestrator + ".jsonl"), c.before.map((m) => JSON.stringify(m) + "\n").join(""));
  const brain = await openBrain(standaloneOwner(), {
    name: defaultOrchestrator,
    instructions: systemPrompt + agentPrompt,
    llm: deepseek(model, key, standaloneLlm()),
    home,
    cwd: home,
    tools: stubbed(tools, c.did),
    noSkills: true,
    noSubagents: true,
    reminders: false,
  });
  try {
    const turn: BrainMessage[] = [];
    let tokens = 0;
    await new Promise<void>((done, fail) => {
      // A real model's turn: the deadline is the point.
      // oxlint-disable-next-line vibevalley/no-test-sleep
      const timer = setTimeout(() => fail(new Error("the turn took too long")), 5 * 60_000);
      brain.subscribe((e) => {
        if (e.type === "message_end" && !isInput(e.message)) {
          if (e.message.role === "assistant") {
            tokens += e.message.usage.totalTokens;
            if (e.message.stopReason === "error") fail(new Error("the model: " + (e.message.errorMessage ?? "")));
          }
          turn.push(e.message);
        }
        if (e.type === "agent_settled") {
          clearTimeout(timer);
          done();
        }
      });
      void brain.send(c.input);
    });
    return { turn, tokens };
  } finally {
    await brain.close();
  }
}

describe.skipIf(!live || !key)("the orchestrator's evals, live", () => {
  it("pass on the real model", { timeout: 60 * 60_000 }, async () => {
    const n = Number(process.env.VIBEVALLEY_EVAL_N || 5);
    expect(Number.isInteger(n) && n >= 1).toBe(true);
    const need = Math.max(n - 1, 1);
    const only = (process.env.VIBEVALLEY_EVAL_ONLY ?? "").split(",").filter(Boolean);
    const cases = [...casesIn(committed), ...(process.env.VIBEVALLEY_EVALS ? casesIn(process.env.VIBEVALLEY_EVALS) : [])].filter(
      ({ file }) => only.length === 0 || only.some((o) => basename(file).startsWith(o)),
    );
    expect(cases.length).toBeGreaterThan(0);
    const tools = await orchestratorTools();
    const rows = ["| case | model | passed | tokens |", "|---|---|---|---|"];
    const short: string[] = [];
    for (const { file, case: c } of cases) {
      const name = basename(file);
      if (c.expect.length === 0) {
        console.log(`${name}: no expect yet, skipped`);
        continue;
      }
      const model = process.env.VIBEVALLEY_EVAL_MODEL || c.model;
      let passed = 0;
      let tokens = 0;
      for (let i = 0; i < n; i++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time to the live model, within its rate limit
        const sample = await replay(c, model, tools);
        tokens += sample.tokens;
        const missed = check(c.expect, sample.turn);
        if (missed.length === 0) passed++;
        else console.log(`${name}, sample ${i + 1}: missed ${missed.join("; ")}\n${transcript(sample.turn)}`);
      }
      rows.push(`| ${name} | ${model} | ${passed}/${n} | ${tokens} |`);
      if (passed < need) short.push(`${name}: passed ${passed} of ${n}, needs ${need}`);
    }
    console.log("\n" + rows.join("\n"));
    expect(short).toEqual([]);
  });
});
