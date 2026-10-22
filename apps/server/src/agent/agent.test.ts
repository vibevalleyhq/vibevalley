import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { type Agent, assistantAgent } from "@vibevalley/protocol";
import { Effect, Exit, Layer } from "effect";
import { type Config, Settings } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { Agents, layer, assistantRuntime, withCast } from "./agent.ts";

const run = <A, E>(config: Config, body: Effect.Effect<A, E, Agents>) =>
  Effect.scoped(body.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(Settings, config))))));

const draft = (change: Partial<Agent> = {}) => ({ ...withCast({ id: "x" } as Agent), id: "", name: "同名", runtime: "pi", ...change }) as Agent;

describe("profiles", () => {
  it.effect("an unreadable config.json is kept aside, and the seeds start", () => {
    const config = testConfig();
    writeFileSync(join(config.home, "config.json"), "{not json");
    return run(
      config,
      Effect.gen(function* () {
        expect((yield* Agents).agents().length).toBeGreaterThan(0);
        const kept = readdirSync(config.home).filter((f) => f.startsWith("config.json.unreadable-"));
        expect(kept).toHaveLength(1);
        expect(readFileSync(join(config.home, kept[0]!), "utf8")).toBe("{not json");
      }),
    );
  });

  it.effect("one that cannot be kept aside stops the start, and is not touched", () => {
    const config = testConfig();
    writeFileSync(join(config.home, "config.json"), "{not json");
    chmodSync(config.home, 0o555);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(run(config, Agents));
      chmodSync(config.home, 0o755);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFileSync(join(config.home, "config.json"), "utf8")).toBe("{not json");
    });
  });

  it("a profile without an animal gets the one the client showed", () => {
    for (const [id, want] of [
      ["backend", "cat"],
      ["agent-7", "fox"],
      ["老周", "hedgehog"],
    ] as const) {
      const got = withCast({ id } as Agent);
      expect([got.look.species, got.look.outfit]).toEqual([want, "farmer"]);
    }
    const kept = withCast({ id: "backend", look: { species: "owl", outfit: "rain" } } as Agent);
    expect([kept.look.species, kept.look.outfit]).toEqual(["owl", "rain"]);
  });

  it.effect("the assistant is built in: not sent work, never deleted, only on VibeValley's own agent", () => {
    const config = testConfig();
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Agents;
        const assistant = s.agent(assistantAgent)!;
        expect([assistant.runtime, assistant.enabled]).toEqual([assistantRuntime, true]);
        expect(s.agents().some((a) => a.id === assistantAgent)).toBe(false);
        expect(s.all().some((a) => a.id === assistantAgent)).toBe(true);
        expect((yield* Effect.flip(s.deleteAgent(assistantAgent)))._tag).toBe("Refused");
        expect(Exit.isFailure(yield* Effect.exit(s.saveAgent({ ...assistant, runtime: "claude" })))).toBe(true);
        yield* s.saveAgent({ ...assistant, model: "deepseek-pro" });
      }),
    ).pipe(
      Effect.andThen(
        run(
          config,
          Effect.map(Agents, (again) => expect(again.agent(assistantAgent)?.model).toBe("deepseek-pro")),
        ),
      ),
    );
  });

  it.effect("creation gives distinct ids; a draft with an id is refused", () =>
    run(
      testConfig(),
      Effect.gen(function* () {
        const s = yield* Agents;
        const ids = new Set<string>();
        const skills = new Set<string>();
        for (let i = 0; i < 12; i++) {
          ids.add((yield* s.createAgent(draft())).id);
          skills.add((yield* s.createSkill({ id: "", name: "Same Skill", body: "" } as never)).id);
        }
        expect(ids.size).toBe(12);
        expect([...skills].slice(0, 3)).toEqual(["same-skill", "same-skill-2", "same-skill-3"]);
        expect((yield* Effect.flip(s.createAgent(draft({ id: "mine" }))))._tag).toBe("Refused");
        const saved = yield* s.saveAgent({ ...draft({ id: "agent-7" }), look: { body: "", trim: "", hat: "", eye: "" } as Agent["look"] });
        expect([saved.look.species, saved.look.outfit, saved.look.build, saved.look.head]).toEqual(["fox", "farmer", "biped", "rounded"]);
      }),
    ),
  );

  it.effect("what is handed out is a copy", () =>
    run(
      testConfig(),
      Effect.gen(function* () {
        const s = yield* Agents;
        const one = s.agents()[0]!;
        one.tags.push("changed");
        one.env.X = "y";
        expect(s.agent(one.id)!.tags).not.toContain("changed");
        const settings = s.settings("pi");
        settings.env.X = "y";
        expect(s.settings("pi").env).toEqual({});
      }),
    ),
  );
});
