import { basename } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { withTimeout } from "@vibevalley/async";
import { Secret } from "@vibevalley/protocol/schema";

import { wallTime } from "#/infra/time.ts";
import { deepseekAccess } from "#/modules/runtime/durable.ts";
import { orchestratorTurn, casesIn, check, committed, type EvalCase, replaySetup, replayWorld, transcript } from "#/testing/evals.ts";

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

/** One sample: the assistant's turn as the farm runs it, on the real DeepSeek through pi-ai, with the case's memory and
 * past; the turn the input begins, and the tokens it took. */
async function replay(c: EvalCase, model: string) {
  const secret = new Secret(key);
  await using farm = await replayWorld(c, deepseekAccess({ key: () => secret, fetch: globalThis.fetch, clock: wallTime }));
  const setup = await replaySetup(farm, c);
  try {
    return await withTimeout(
      (signal) => orchestratorTurn(farm, { model, tools: setup.tools, memory: c.memory, before: c.before, input: setup.input }, signal),
      5 * 60_000,
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new EvalFailure("the turn took too long", { cause: e });
    throw e;
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
