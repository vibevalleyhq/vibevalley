import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Config, Console, Effect, FileSystem, Path, Redacted, Schema, Stream } from "effect";

import { makeBrain } from "@vibevalley/agent/brain";
import { memoryFile } from "@vibevalley/agent/memory";
import { type BrainMessage, transcript } from "@vibevalley/agent/messages";
import { deepseek } from "@vibevalley/ai/client";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { standaloneLlm } from "#/chat/chat.ts";
import { casesIn, check, committed, type EvalCase, isInput, replaySetup, replayWorld } from "#/testing/evals.ts";

import { agentPrompt, systemPrompt } from "./prompts.ts";

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));
// Read as the file is collected: whether the suite runs at all is decided then.
const env = Effect.runSync(
  Config.all({
    live: optional("VIBEVALLEY_EVALS_LIVE"),
    key: Config.Redacted("DEEPSEEK_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
    n: optional("VIBEVALLEY_EVAL_N"),
    only: optional("VIBEVALLEY_EVAL_ONLY"),
    evals: optional("VIBEVALLEY_EVALS"),
    model: optional("VIBEVALLEY_EVAL_MODEL"),
  }),
);
const live = env.live === "1";
const key = Redacted.value(env.key);
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

class EvalFailure extends Schema.TaggedError<EvalFailure, { readonly brand: unique symbol }>()("EvalFailure", { message: Schema.String }) {}

/** One sample: the brain as the orchestrator makes it, with the case's memory and channel; the turn the input begins, and
 * the tokens it took. */
const replay = Effect.fnUntraced(function* (c: EvalCase, model: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = tempDir("vibevalley-eval-");
  yield* fs.writeFileString(memoryFile(home), c.memory);
  const before = yield* Effect.forEach(c.before, (m) => json(m));
  yield* fs.writeFileString(path.join(home, defaultOrchestrator + ".jsonl"), before.map((line) => line + "\n").join(""));
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* replaySetup(c);
      const brain = yield* makeBrain({
        name: defaultOrchestrator,
        instructions: systemPrompt + agentPrompt,
        llm: deepseek(model, key, standaloneLlm()),
        home,
        cwd: home,
        tools: setup.tools,
        noSkills: true,
        noSubagents: true,
        reminders: false,
      });
      const events = yield* brain.events;
      const turn: BrainMessage[] = [];
      let tokens = 0;
      yield* Effect.andThen(
        brain.send(setup.input),
        events.pipe(
          Stream.takeUntil((event) => event.type === "agent_settled"),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type !== "message_end" || isInput(event.message)) return;
              if (event.message.role === "assistant") {
                tokens += event.message.usage.totalTokens;
                if (event.message.stopReason === "error") return yield* EvalFailure.make({ message: "the model: " + (event.message.errorMessage ?? "") });
              }
              turn.push(event.message);
            }),
          ),
        ),
      ).pipe(Effect.timeoutOrElse({ duration: "5 minutes", orElse: () => EvalFailure.make({ message: "the turn took too long" }) }));
      return { turn, tokens };
    }).pipe(Effect.provide(replayWorld(c))),
  );
});

describe.skipIf(!live || !key)("the orchestrator's evals, live", () => {
  it.live(
    "pass on the real model",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const n = Number(env.n || 5);
        expect(Number.isInteger(n) && n >= 1).toBe(true);
        const need = Math.max(n - 1, 1);
        const only = env.only.split(",").filter(Boolean);
        const cases = [...casesIn(committed), ...(env.evals ? casesIn(env.evals) : [])].filter(
          ({ file }) => only.length === 0 || only.some((o) => path.basename(file).startsWith(o)),
        );
        expect(cases.length).toBeGreaterThan(0);
        const rows = ["| case | model | passed | tokens |", "|---|---|---|---|"];
        const short: string[] = [];
        for (const { file, case: c } of cases) {
          const name = path.basename(file);
          if (c.expect.length === 0) {
            yield* Console.log(`${name}: no expect yet, skipped`);
            continue;
          }
          const model = env.model || c.model;
          let passed = 0;
          let tokens = 0;
          for (let i = 0; i < n; i++) {
            // One request at a time to the live model, within its rate limit.
            const sample = yield* replay(c, model);
            tokens += sample.tokens;
            const missed = check(c.expect, sample.turn);
            if (missed.length === 0) passed++;
            else yield* Console.log(`${name}, sample ${i + 1}: missed ${missed.join("; ")}\n${transcript(sample.turn)}`);
          }
          rows.push(`| ${name} | ${model} | ${passed}/${n} | ${tokens} |`);
          if (passed < need) short.push(`${name}: passed ${passed} of ${n}, needs ${need}`);
        }
        yield* Console.log("\n" + rows.join("\n"));
        expect(short).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60 * 60_000,
  );
});
