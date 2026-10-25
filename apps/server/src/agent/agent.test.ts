import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { type Agent, orchestratorAgent } from "@vibevalley/protocol";
import { Effect, Exit, Layer } from "effect";
import { type Config, Settings } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { Agents, layer, orchestratorRuntime, withCast } from "./agent.ts";
import { seedAgents } from "./seed.ts";

const run = <A, E>(config: Config, body: Effect.Effect<A, E, Agents>) =>
  Effect.scoped(body.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(Settings, config))))));

/** A whole profile (a seed), as the page sends one: config.json keeps only what reads as a profile. */
const draft = (change: Partial<Agent> = {}): Agent => ({
  ...seedAgents().find((a) => a.id === "lab")!,
  id: "",
  name: "同名",
  runtime: "pi",
  ...change,
});

describe("profiles", () => {
  it.effect("deleting a skill removes profile references and a recreated name does not reattach it", () => {
    const config = testConfig();
    let profile = "";
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Agents;
        const skill = yield* s.createSkill({
          id: "",
          name: "Transient Skill",
          description: "",
          body: "old",
        });
        profile = (yield* s.createAgent(draft({ skills: [skill.id, "other"] }))).id;
        yield* s.saveAgent({ ...s.agent(orchestratorAgent)!, skills: [skill.id] });
        yield* s.deleteSkill(skill.id);
        expect(s.agent(profile)?.skills).toEqual(["other"]);
        expect(s.agent(orchestratorAgent)?.skills).toEqual([]);
        const recreated = yield* s.createSkill({
          id: "",
          name: skill.name,
          description: "",
          body: "new",
        });
        expect(recreated.id).toBe(skill.id);
        expect(s.agent(profile)?.skills).not.toContain(recreated.id);
      }),
    ).pipe(
      Effect.andThen(
        run(
          config,
          Effect.gen(function* () {
            const s = yield* Agents;
            expect(s.agent(profile)?.skills).toEqual(["other"]);
            expect(s.agent(orchestratorAgent)?.skills).toEqual([]);
          }),
        ),
      ),
    );
  });

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

  it.effect("the orchestrator is built in: not sent work, never deleted, only on VibeValley's own agent", () => {
    const config = testConfig();
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Agents;
        const orchestrator = s.agent(orchestratorAgent)!;
        expect([orchestrator.runtime, orchestrator.enabled]).toEqual([orchestratorRuntime, true]);
        expect(s.agents().some((a) => a.id === orchestratorAgent)).toBe(false);
        expect(s.all().some((a) => a.id === orchestratorAgent)).toBe(true);
        expect((yield* Effect.flip(s.deleteAgent(orchestratorAgent)))._tag).toBe("Refused");
        expect(Exit.isFailure(yield* Effect.exit(s.saveAgent({ ...orchestrator, runtime: "claude" })))).toBe(true);
        yield* s.saveAgent({ ...orchestrator, model: "deepseek-pro" });
      }),
    ).pipe(
      Effect.andThen(
        run(
          config,
          Effect.map(Agents, (again) => expect(again.agent(orchestratorAgent)?.model).toBe("deepseek-pro")),
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
        const saved = yield* s.saveAgent({
          ...draft({ id: "agent-7" }),
          look: { body: "", trim: "", hat: "", eye: "" } as Agent["look"],
        });
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
