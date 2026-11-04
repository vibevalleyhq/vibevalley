import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { endpoints } from "@vibevalley/protocol/api";
import { Preview } from "@vibevalley/protocol/schema";

import { reach } from "./reach.ts";
import { cli, farm, lookIn, memoriesOf, workingFarm } from "./testing.ts";

const json = (text: string): unknown => JSON.parse(text);

describe("the command line", () => {
  it.effect("reaches every endpoint: by the command reach.ts names, which is there with an example, or through api", () =>
    Effect.gen(function* () {
      for (const command of new Set(Object.values(reach).filter((c) => c !== "api"))) {
        const help = yield* cli([...command.split(" "), "--help"]);
        expect({ command, code: help.code, examples: help.out.includes("EXAMPLES") }).toEqual({ command, code: 0, examples: true });
      }
      const listed = new Set((yield* cli(["api", "list"])).out.split("\n").map((l) => l.trim().split("  ")[0]));
      expect(endpoints.map((e) => e.op).filter((op) => !listed.has(op))).toEqual([]);
    }),
  );

  // A dry run is an endpoint of its own that takes what the real one takes, so --dry-run can call it with the same words.
  it("gives each command that changes what cannot be taken back a dry run of the same shape", () => {
    for (const e of endpoints.filter((x) => x.dryRun)) {
      const preview = endpoints.find((x) => x.op === e.dryRun);
      expect({ op: e.op, preview: preview?.op }).toEqual({ op: e.op, preview: e.dryRun });
      expect([preview!.about, preview!.input === e.input, preview!.result === Preview, preview!.can]).toEqual([e.about, true, true, e.can]);
    }
    expect(endpoints.filter((e) => e.op.endsWith(".delete") && !e.dryRun).map((e) => e.op)).toEqual([]);
  });

  it.live("answers in short lines, the name to use next first, and in the protocol's shape with --format json", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const at = (...args: string[]) => [...args, "--server", server];
      const made = yield* cli(at("issue", "new", "试一下", "--criterion", "能打开"));
      expect(made.out).toMatch(/^#1 {2}draft {2}试一下$/u);
      const shown = (yield* cli(at("issue", "show", "#1"))).out;
      expect(shown).toContain("能打开");
      expect(shown.split("\n").at(-1)).toMatch(/^能做：/u);
      const edited = yield* cli(at("issue", "edit", "1", "--title", "改一下"));
      expect(edited.out).toMatch(/^#1 {2}draft {2}改一下$/u);
      const asJson = json((yield* cli(at("issue", "show", "1", "--format", "json"))).out) as { number: number; criteria: string[] };
      expect([asJson.number, asJson.criteria]).toEqual([1, ["能打开"]]);
      for (const title of ["二", "三", "四"]) yield* cli(at("issue", "new", title));
      const list = yield* cli(at("issue", "list"));
      const listJson = yield* cli(at("issue", "list", "--format", "json"));
      expect(list.out.split("\n")).toHaveLength(4);
      // What an agent reads by default is a small part of the whole.
      expect(list.out.length * 3).toBeLessThan(listJson.out.length);
      const limited = yield* cli(at("issue", "list", "--limit", "2"));
      expect(limited.out.split("\n").at(-1)).toContain("--limit 4");
      // With no --server, VIBEVALLEY_SERVER says where.
      expect((yield* cli(["issue", "show", "1"], "", { VIBEVALLEY_SERVER: server })).code).toBe(0);
    }),
  );

  it.live("fails with nothing on stdout, a JSON failure on stderr, an exit code by kind and the commands to go on with", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const at = (...args: string[]) => [...args, "--server", server];
      const missingArgument = yield* cli(at("issue", "show"));
      expect([missingArgument.code, missingArgument.out, missingArgument.failure?.tag]).toEqual([2, "", "MissingArgument"]);
      expect((yield* cli(at("issue", "list", "--bogus", "1"))).failure?.tag).toBe("UnrecognizedOption");
      const missing = yield* cli(at("issue", "show", "nope"));
      expect([missing.code, missing.failure?.tag, missing.failure?.next]).toEqual([4, "Missing", [{ say: "列出工单，找它的编号", run: ["issue", "list"] }]]);
      yield* cli(at("issue", "new", "还是草稿"));
      // An act the issue does not take now is refused, naming the ones it does as commands to run.
      const refused = yield* cli(at("issue", "accept", "1"));
      expect([refused.code, refused.failure?.tag]).toEqual([3, "Refused"]);
      const cancel = refused.failure?.next?.find((n) => n.say === "cancel");
      expect(cancel?.run).toEqual(["issue", "cancel", "1"]);
      expect((yield* cli(at(...cancel!.run!))).out).toMatch(/^#1 {2}canceled/u);
      const noWords = yield* cli(at("issue", "say", "1"));
      expect([noWords.code, noWords.failure?.tag]).toEqual([2, "MissingArgument"]);
      const nowhere = yield* cli(at("channel", "read", "nowhere"));
      expect([nowhere.code, nowhere.failure?.tag]).toEqual([4, "Missing"]);
      expect(nowhere.failure?.message).toContain("#general");
      expect((yield* cli(["issue", "list", "--server", "http://127.0.0.1:9"])).failure?.tag).toBe("Unreachable");
      const wrong = yield* cli(["issue", "nope"]);
      expect([wrong.code, wrong.out, wrong.failure?.tag]).toEqual([2, "", "UnknownSubcommand"]);
    }),
  );

  it.live("--dry-run says what would happen and changes nothing; a change with no dry run is refused", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const at = (...args: string[]) => [...args, "--server", server];
      yield* cli(at("issue", "new", "先试跑"));
      const cancel = yield* cli(at("issue", "cancel", "1", "--dry-run"));
      expect([cancel.code, cancel.out]).toEqual([0, "#1 关成已取消：还没派过"]);
      expect((yield* cli(at("issue", "show", "1"))).out.split("\n")[1]).toMatch(/^draft/u);
      const create = yield* cli(at("issue", "new", "不该建", "--dry-run"));
      expect([create.code, create.failure?.tag]).toEqual([2, "NoDryRun"]);
      const added = yield* cli(at("cron", "add", "早上看看", "看看昨天的改动", "--daily", "09:00"));
      const id = added.out.split("  ")[0]!;
      expect((yield* cli(at("cron", "remove", id, "--dry-run"))).out).toContain("删掉定时任务「早上看看」");
      expect((yield* cli(at("cron", "list"))).out).toContain(id);
    }),
  );

  it.live("api call reaches any endpoint, its --json checked against the endpoint's Schema before it is sent", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const at = (...args: string[]) => [...args, "--server", server];
      yield* cli(at("issue", "new", "直接调"));
      expect(json((yield* cli(at("api", "call", "issue.get", "--json", JSON.stringify({ id: "1" })))).out)).toMatchObject({ number: 1, title: "直接调" });
      expect((yield* cli(at("api", "call", "issue.get", "--json", "-"), JSON.stringify({ id: "1" }))).code).toBe(0);
      const wrongBody = yield* cli(at("api", "call", "issue.create", "--json", JSON.stringify({ title: 1 })));
      expect([wrongBody.code, wrongBody.failure?.tag]).toEqual([2, "InvalidValue"]);
      expect(wrongBody.failure?.message).toContain("title");
      const noOp = yield* cli(at("api", "call", "issue.nothing"));
      expect([noOp.code, noOp.failure?.next?.[0]?.run]).toEqual([4, ["api", "list"]]);
      const preview = json((yield* cli(at("api", "call", "agent.delete", "--json", JSON.stringify({ id: "docs" }), "--dry-run"))).out) as { does: string[] };
      expect(preview.does[0]).toContain("删掉档案");
      const schemas = json((yield* cli(at("api", "list", "--module", "issue", "--format", "json"))).out) as { op: string; input: unknown }[];
      expect(schemas.find((e) => e.op === "issue.create")?.input).toMatchObject({ type: "object" });
      expect(json((yield* cli(at("api", "state"))).out)).toHaveProperty("state");
    }),
  );

  it.effect("every place a missing thing points to is a command that is there", () =>
    Effect.gen(function* () {
      for (const next of [...Object.values(lookIn), memoriesOf("docs")]) {
        if (!next.run) continue;
        const help = yield* cli([...next.run.filter((w) => !w.startsWith("{")), "--help"]);
        expect({ run: next.run, code: help.code }).toEqual({ run: next.run, code: 0 });
      }
    }),
  );

  it.live("an agent does an issue from start to end with these commands alone, reading their text", () =>
    Effect.gen(function* () {
      const server = yield* workingFarm;
      const at = (...args: string[]) => [...args, "--server", server];
      const profile = json((yield* cli(at("api", "call", "agent.create", "--json", JSON.stringify(scripted)))).out) as { id: string };
      expect((yield* cli(at("project", "add", "clock"))).code).toBe(0);
      // The test helper asks which port when its issue says 先问清楚, with options when it says 给选项, and commits clock.ts
      // when it says 提交.
      const made = yield* cli(at("issue", "new", "打卡页先问清楚，给选项，提交", "--project", "clock", "--agent", profile.id, "--criterion", "clock-in works"));
      const n = /^#(\d+)/u.exec(made.out)?.[1] ?? "";
      const asked = yield* cli(at("issue", "work", n, "--timeout", "30"));
      expect(asked.code).toBe(0);
      const waiting = (yield* cli(at("issue", "show", n))).out;
      expect(waiting).toContain("用 8797");
      expect(waiting.split("\n").at(-1)).toContain("answer");
      expect((yield* cli(at("issue", "answer", n, "用 8797"))).code).toBe(0);
      expect((yield* cli(at("issue", "work", n, "--timeout", "30"))).code).toBe(0);
      expect((yield* cli(at("issue", "show", n))).out.split("\n")[1]).toMatch(/^reviewing/u);
      expect((yield* cli(at("issue", "diff", n))).out).toContain("clock.ts");
      expect((yield* cli(at("issue", "accept", n))).out).toMatch(new RegExp(`^#${n} {2}done`, "u"));
    }),
  );
});

/** A profile on the test helper (the farm's pi is it: testing/worker.ts). */
const scripted = {
  id: "",
  name: "fox",
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
  worktree: true,
  tags: [],
  look: { species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
};
