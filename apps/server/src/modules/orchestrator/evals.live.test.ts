import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeBrain } from "@vibevalley/agent/brain";
import { memoryFile } from "@vibevalley/agent/memory";
import { type BrainMessage, transcript } from "@vibevalley/agent/messages";
import { deepseek } from "@vibevalley/ai/client";
import { makeLlm } from "@vibevalley/ai/llm";
import { withTimeout } from "@vibevalley/async";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { casesIn, check, committed, type EvalCase, isInput, replaySetup, replayWorld } from "#/testing/evals.ts";

import { agentPrompt, systemPrompt } from "./prompts.ts";

// Read as the file is collected: whether the suite runs at all is decided then.
const env = {
  live: process.env.VIBEVALLEY_EVALS_LIVE ?? "",
  key: process.env.DEEPSEEK_API_KEY ?? "",
  n: process.env.VIBEVALLEY_EVAL_N ?? "",
  only: process.env.VIBEVALLEY_EVAL_ONLY ?? "",
  evals: process.env.VIBEVALLEY_EVALS ?? "",
  model: process.env.VIBEVALLEY_EVAL_MODEL ?? "",
};
const live = env.live === "1";
const key = env.key;

class EvalFailure extends Error {
  override readonly name = "EvalFailure";
}

/** One sample: the brain as the orchestrator makes it, with the case's memory and channel; the turn the input begins, and
 * the tokens it took. */
async function replay(c: EvalCase, model: string) {
  const home = tempDir("vibevalley-eval-");
  await writeFile(memoryFile(home), c.memory);
  await writeFile(join(home, defaultOrchestrator + ".jsonl"), c.before.map((m) => JSON.stringify(m) + "\n").join(""));
  await using farm = await replayWorld(c);
  const setup = await replaySetup(farm, c);
  const brain = await makeBrain({
    name: defaultOrchestrator,
    instructions: systemPrompt + agentPrompt,
    llm: deepseek(model, key, makeLlm()),
    home,
    cwd: home,
    tools: setup.tools,
    noSkills: true,
    noSubagents: true,
    reminders: false,
  });
  try {
    using events = brain.events();
    const turn: BrainMessage[] = [];
    let tokens = 0;
    await brain.send(setup.input);
    try {
      await withTimeout(async (signal) => {
        for (;;) {
          const next = await events.next(signal);
          if (next.done === true) return;
          const event = next.value;
          if (event.type === "agent_settled") return;
          if (event.type !== "message_end" || isInput(event.message)) continue;
          if (event.message.role === "assistant") {
            tokens += event.message.usage.totalTokens;
            if (event.message.stopReason === "error") throw new EvalFailure("the model: " + (event.message.errorMessage ?? ""));
          }
          turn.push(event.message);
        }
      }, 5 * 60_000);
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new EvalFailure("the turn took too long", { cause: e });
      throw e;
    }
    return { turn, tokens };
  } finally {
    await brain.close();
  }
}

describe.skipIf(!live || !key)("the orchestrator's evals, live", () => {
  it("pass on the real model", { timeout: 60 * 60_000 }, async () => {
    const n = Number(env.n || 5);
    expect(Number.isInteger(n) && n >= 1).toBe(true);
    const need = Math.max(n - 1, 1);
    const only = env.only.split(",").filter(Boolean);
    const cases = [...casesIn(committed), ...(env.evals ? casesIn(env.evals) : [])].filter(
      ({ file }) => only.length === 0 || only.some((o) => basename(file).startsWith(o)),
    );
    expect(cases.length).toBeGreaterThan(0);
    const rows = ["| case | model | passed | tokens |", "|---|---|---|---|"];
    const short: string[] = [];
    for (const { file, case: c } of cases) {
      const name = basename(file);
      if (c.expect.length === 0) {
        console.log(`${name}: no expect yet, skipped`);
        continue;
      }
      const model = env.model || c.model;
      let passed = 0;
      let tokens = 0;
      for (let i = 0; i < n; i++) {
        // One request at a time to the live model, within its rate limit.
        const sample = await replay(c, model);
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
