import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { type Agent, defaultOrchestrator } from "@vibevalley/protocol";
import { Cause, Effect, Exit, Layer } from "effect";
import { type Config, Settings } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { Agents, layer, orchestratorRuntime, withCast } from "./agent.ts";
import { defaultSettings, seedAgents } from "./seed.ts";

const run = <A, E>(config: Config, body: Effect.Effect<A, E, Agents>) =>
  Effect.scoped(body.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(Settings, config))))));

const draft = (change: Partial<Agent> = {}): Agent => ({
  id: "",
  name: "同名",
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: false,
  tags: [],
  look: { build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
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
        yield* s.saveAgent({ ...s.agent(defaultOrchestrator)!, skills: [skill.id] });
        yield* s.deleteSkill(skill.id);
        expect(s.agent(profile)?.skills).toEqual(["other"]);
        expect(s.agent(defaultOrchestrator)?.skills).toEqual([]);
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
            expect(s.agent(defaultOrchestrator)?.skills).toEqual([]);
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

  it.effect("valid JSON with the wrong profile shape is kept aside", () => {
    const config = testConfig();
    const raw = `{"agents":{},"skills":[],"settings":{}}`;
    writeFileSync(join(config.home, "config.json"), raw);
    return run(
      config,
      Effect.gen(function* () {
        expect((yield* Agents).agents().length).toBeGreaterThan(0);
        const kept = readdirSync(config.home).filter((f) => f.startsWith("config.json.unreadable-"));
        expect(kept).toHaveLength(1);
        expect(readFileSync(join(config.home, kept[0]!), "utf8")).toBe(raw);
      }),
    );
  });

  it.effect("a profile whose look lacks a build and a head is filled in, and nothing is set aside", () => {
    const config = testConfig();
    const mine = { ...seedAgents().find((a) => a.id === "lab")!, id: "mine", name: "我的" };
    const { build: _, head: __, ...look } = mine.look;
    const raw = JSON.stringify({
      agents: [{ ...mine, look }],
      skills: [{ id: "s1", name: "tidy", description: "整理", body: "整理代码" }],
      settings: { pi: { ...defaultSettings(), defaultModel: "deepseek-chat" } },
    });
    writeFileSync(join(config.home, "config.json"), raw);
    return run(
      config,
      Effect.gen(function* () {
        const agents = yield* Agents;
        expect(agents.agent("mine")?.look).toMatchObject({ build: "biped", head: "rounded" });
        expect(agents.skills().map((k) => k.id)).toEqual(["s1"]);
        expect(agents.settings("pi").defaultModel).toBe("deepseek-chat");
        expect(readdirSync(config.home).filter((f) => f.startsWith("config.json.unreadable-"))).toEqual([]);
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
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
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
        const orchestrator = s.agent(defaultOrchestrator)!;
        expect([orchestrator.runtime, orchestrator.enabled]).toEqual([orchestratorRuntime, true]);
        expect(s.agents().some((a) => a.id === defaultOrchestrator)).toBe(false);
        expect(s.all().some((a) => a.id === defaultOrchestrator)).toBe(true);
        expect((yield* Effect.flip(s.deleteAgent(defaultOrchestrator)))._tag).toBe("Refused");
        expect((yield* Effect.flip(s.saveAgent({ ...orchestrator, runtime: "claude" })))._tag).toBe("Refused");
        yield* s.saveAgent({ ...orchestrator, model: "deepseek-pro" });
      }),
    ).pipe(
      Effect.andThen(
        run(
          config,
          Effect.map(Agents, (again) => expect(again.agent(defaultOrchestrator)?.model).toBe("deepseek-pro")),
        ),
      ),
    );
  });

  // A profile is an orchestrator or a worker; there may be several orchestrators, each on VibeValley's own agent, and the
  // default one stays one.
  it.effect("a profile's role: several orchestrators, each on VibeValley's own agent, and work goes only to workers", () =>
    run(
      testConfig(),
      Effect.gen(function* () {
        const s = yield* Agents;
        expect((yield* Effect.flip(s.createAgent(draft({ name: "外头的管家", role: "orchestrator", runtime: "claude" }))))._tag).toBe("Refused");
        const lead = yield* s.createAgent(draft({ name: "前端组长", role: "orchestrator", runtime: orchestratorRuntime }));
        expect(s.orchestrators().map((a) => a.id)).toEqual([defaultOrchestrator, lead.id]);
        expect([s.isOrchestrator(lead.id), s.isOrchestrator("backend")]).toEqual([true, false]);
        expect(s.agents().some((a) => a.role === "orchestrator")).toBe(false);
        expect((yield* Effect.flip(s.saveAgent({ ...s.agent(defaultOrchestrator)!, role: "worker" })))._tag).toBe("Refused");
        yield* s.saveAgent({ ...lead, role: "worker" });
        expect(s.agents().some((a) => a.id === lead.id)).toBe(true);
        yield* s.deleteAgent(lead.id);
      }),
    ),
  );

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
