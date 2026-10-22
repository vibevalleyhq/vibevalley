// The assistant's evals on the real model, and so never in the default run: VIBEVALLEY_EVALS_LIVE=1 with DEEPSEEK_API_KEY
// (npm run evals), and it costs money. Each case is sampled VIBEVALLEY_EVAL_N times (5) and passes when all but one of them
// do; VIBEVALLEY_EVALS adds a folder of cases (a home's assistant/evals), VIBEVALLEY_EVAL_MODEL another model.

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { assistantAgent } from "@vibevalley/protocol";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Brain } from "../agent/brain/agent.ts";
import { deepseek } from "../agent/brain/config.ts";
import { memoryFile } from "../agent/brain/memory.ts";
import { transcript } from "../agent/brain/messages.ts";
import { world } from "../testing/world.ts";
import { Tools } from "../tool/tool.ts";
import { casesIn, check, committed, type EvalCase, isInput } from "./evals.ts";
import { agentPrompt, systemPrompt } from "./assistant.ts";

const live = process.env.VIBEVALLEY_EVALS_LIVE === "1";
const key = process.env.DEEPSEEK_API_KEY ?? "";
const noResult = "（评测里没有这个工具的结果）";

/** The assistant's tool definitions, from a farm that is let go at once: every call is answered by stubs. */
const assistantTools = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* Tools;
        return t.assistant(() => ({ agent: assistantAgent, session: "", project: "", here: "", picked: "", owner: true }));
      }).pipe(Effect.provide(world())),
    ),
  );

/** Every farm tool answers with what the case recorded for it, in the order it was called; none touches the farm. Its own
 * tools (memory, archive) work on the replay's own home. */
function stubbed(tools: readonly AgentTool[], did: readonly AgentMessage[]): AgentTool[] {
  const recorded = new Map<string, Extract<AgentMessage, { role: "toolResult" }>[]>();
  for (const m of did) if (m.role === "toolResult") recorded.set(m.toolName, [...(recorded.get(m.toolName) ?? []), m]);
  return tools.map((t) => ({
    ...t,
    execute: async () => {
      const next = recorded.get(t.name)?.shift();
      if (!next) return { content: [{ type: "text", text: noResult }], details: undefined };
      if (next.isError) throw new Error(next.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
      return { content: next.content, details: undefined };
    },
  }));
}

/** One sample: the brain as the assistant makes it, with the case's memory and conversation; the turn the input begins, and
 * the tokens it took. */
async function replay(c: EvalCase, model: string, tools: readonly AgentTool[]): Promise<{ turn: AgentMessage[]; tokens: number }> {
  const home = mkdtempSync(join(tmpdir(), "vibevalley-eval-"));
  writeFileSync(memoryFile(home), c.memory);
  writeFileSync(join(home, assistantAgent + ".jsonl"), c.before.map((m) => JSON.stringify(m) + "\n").join(""));
  const brain = await Brain.start({
    name: assistantAgent,
    instructions: systemPrompt + agentPrompt,
    llm: deepseek(model, key),
    home,
    cwd: home,
    tools: stubbed(tools, c.did),
    noSkills: true,
    noSubagents: true,
    recurrences: false,
  });
  try {
    const turn: AgentMessage[] = [];
    let tokens = 0;
    await new Promise<void>((done, fail) => {
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
      brain.send(c.input);
    });
    return { turn, tokens };
  } finally {
    await brain.close();
  }
}

describe.skipIf(!live || !key)("the assistant's evals, live", () => {
  it("pass on the real model", { timeout: 60 * 60_000 }, async () => {
    const n = Number(process.env.VIBEVALLEY_EVAL_N || 5);
    expect(Number.isInteger(n) && n >= 1).toBe(true);
    const need = Math.max(n - 1, 1);
    const cases = [...casesIn(committed), ...(process.env.VIBEVALLEY_EVALS ? casesIn(process.env.VIBEVALLEY_EVALS) : [])];
    const tools = await assistantTools();
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
