import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { type Agent, defaultOrchestrator, orchestratorRuntime } from "@vibevalley/protocol";
import { Cause, Effect, Exit, Layer } from "effect";
import { type ConfigShape, Config } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { Agents, layer, withCast } from "./agent.ts";
import { defaultSettings } from "./seed.ts";
import { starter } from "../testing/layers.ts";

const run = <A, E>(config: ConfigShape, body: Effect.Effect<A, E, Agents>) =>
  Effect.scoped(body.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(Config, config))))));

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
    const mine = { ...starter("lab"), id: "mine", name: "我的" };
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

  it.effect("a new farm has only the default orchestrator, and the starters the configuration names", () =>
    run(
      testConfig({ agent: { model: "", starters: [] } }),
      Effect.gen(function* () {
        const s = yield* Agents;
        expect(s.all().map((a) => [a.id, a.from?.template])).toEqual([[defaultOrchestrator, defaultOrchestrator]]);
      }),
    ).pipe(
      Effect.andThen(
        run(
          testConfig({ agent: { model: "", starters: ["docs", "nobody", "lab"] } }),
          Effect.map(Agents, (s) => expect(s.all().map((a) => a.id)).toEqual([defaultOrchestrator, "docs", "lab"])),
        ),
      ),
    ),
  );

  it.effect("a template installs as many profiles as asked, and an update is taken only when asked", () =>
    run(
      testConfig(),
      Effect.gen(function* () {
        const s = yield* Agents;
        const second = yield* s.installTemplate("backend");
        expect([second.id, second.name, second.from]).toEqual(["backend-2", "后端老周 2", { template: "backend", version: 1 }]);
        expect(s.templates().find((t) => t.id === "backend")?.installed).toEqual(["backend", "backend-2"]);
        expect((yield* Effect.flip(s.installTemplate("nobody")))._tag).toBe("Missing");
        // The owner's changes stay until the profile is made again from the template; the machine's stay after it too.
        yield* s.saveAgent({ ...second, name: "后端二号", persona: "我自己写的", env: { CI: "1" }, from: { template: "backend", version: 0 } });
        const again = yield* s.updateFromTemplate("backend-2");
        expect([again.name, again.persona, again.env, again.from?.version]).toEqual(["后端二号", starter("backend").persona, { CI: "1" }, 1]);
        const hand = yield* s.createAgent(draft({ name: "手捏的" }));
        expect((yield* Effect.flip(s.updateFromTemplate(hand.id)))._tag).toBe("Refused");
      }),
    ),
  );

  it.effect("a template folder on this machine is added beside the built-in ones, installed, and deleted", () => {
    const config = testConfig();
    const folder = join(config.home, "lead-template");
    mkdirSync(folder);
    writeFileSync(join(folder, "agent.json"), JSON.stringify({ id: "lead", version: 2, role: "orchestrator", name: "组长", duty: "专管前端" }));
    writeFileSync(join(folder, "persona.md"), "你专管前端的工单。\n");
    writeFileSync(join(folder, "notes.txt"), "not a template's");
    const broken = join(config.home, "broken-template");
    mkdirSync(broken);
    writeFileSync(join(broken, "agent.json"), JSON.stringify({ id: "Bad Id", version: 1, role: "worker", name: "坏的", runtime: "pi" }));
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Agents;
        expect(yield* Effect.flip(s.addTemplate(broken))).toMatchObject({ _tag: "Refused", reason: expect.stringMatching(/Bad Id/) });
        expect((yield* Effect.flip(s.addTemplate(join(config.home, "nowhere"))))._tag).toBe("Refused");
        const added = yield* s.addTemplate(folder);
        expect([added.source, added.runtime, added.persona]).toEqual(["added", orchestratorRuntime, "你专管前端的工单。"]);
        expect(readdirSync(join(config.home, "agent-templates", "lead")).sort()).toEqual(["agent.json", "persona.md"]);
        expect((yield* Effect.flip(s.addTemplate(folder)))._tag).toBe("Refused");
        const lead = yield* s.installTemplate("lead");
        expect([lead.role, s.isOrchestrator(lead.id)]).toEqual(["orchestrator", true]);
        expect((yield* s.previewDeleteTemplate("lead")).does[0]).toContain("1 份档案留着");
        expect((yield* Effect.flip(s.deleteTemplate("backend")))._tag).toBe("Refused");
        yield* s.deleteTemplate("lead");
        expect(s.templates().some((t) => t.id === "lead")).toBe(false);
        expect(s.agent(lead.id)?.from).toEqual({ template: "lead", version: 2 });
      }),
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
