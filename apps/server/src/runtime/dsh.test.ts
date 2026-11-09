import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Formatter, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { dshRuntime, modelId, optionValue, repoModels } from "./dsh.ts";
import recorded from "./testdata/dsh-acp-0.2.1-rc.2.json" with { type: "json" };

const answersFile = resolve(import.meta.dirname, "testdata/dsh-acp-0.2.1-rc.2.json");
const answers: Record<string, unknown> = recorded;
const onDisk = <A, E>(work: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(FileSystem.FileSystem, work).pipe(Effect.provide(NodeServices.layer)));
const LoggedRequest = Schema.fromJsonString(
  Schema.Struct({ method: Schema.String, params: Schema.Struct({ configId: Schema.optionalKey(Schema.String), value: Schema.optionalKey(Schema.String) }) }),
);

/** `dsh --profile acp` played: it answers with what dsh 0.2.1-rc.2 answered (testdata), and logs every request. */
async function fakeDsh() {
  const dir = tempDir("vibevalley-dsh-");
  const log = join(dir, "log.jsonl");
  const script = join(dir, "dsh");
  const text = `#!${process.execPath}
const fs = require("node:fs");
const answers = JSON.parse(fs.readFileSync(${Formatter.format(answersFile)}, "utf8"));
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || !m.method) return;
  fs.appendFileSync(${Formatter.format(log)}, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
  let answer = answers[m.method] ?? {};
  if (m.method === "session/set_config_option") {
    const opened = answers["session/new"];
    for (const o of opened.configOptions) if (o.id === m.params.configId) o.currentValue = m.params.value;
    answer = { sessionId: "dsh-session", configOptions: opened.configOptions };
  }
  if (m.method === "session/prompt") answer = { stopReason: "end_turn" };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }) + "\\n");
});
`;
  await onDisk((fs) => Effect.andThen(fs.writeFileString(script, text), fs.chmod(script, 0o755)));
  return { dir, script, log };
}

describe("DeepSeek Harness", () => {
  it("values a model by its provider/model pair", () => {
    const cases: [string, string][] = [
      ["deepseek-flash", `["deepseek-official","deepseek-flash"]`],
      ["deepseek-official/deepseek-flash", `["deepseek-official","deepseek-flash"]`],
      ["deepseek-v4-flash", `["deepseek-official","deepseek-flash"]`],
      ["deepseek-official/deepseek-v4-flash", `["deepseek-official","deepseek-flash"]`],
      [`["openrouter","x"]`, `["openrouter","x"]`],
      ["", ""],
    ];
    for (const [model, want] of cases) expect(optionValue(model)).toBe(want);
    expect(modelId(`["deepseek-official","deepseek-flash"]`)).toBe("deepseek-official/deepseek-flash");
  });

  it("reads the models of a new session, grouped by provider", () => {
    const models = repoModels(answers["session/new"])!;
    expect(models.map((m) => m.id)).toEqual(["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"]);
    for (const m of models) expect([m.effortLevels, m.defaultEffort]).toEqual([["low", "high", "max"], "high"]);
    expect([models[0]!.default, models[1]!.displayName, models[0]!.displayName]).toEqual([true, "DeepSeek-V4-Pro", "DeepSeek-V4.1-Flash-1017"]);
  });

  it("sets a session's model by its pair, and its effort", async () => {
    const fake = await fakeDsh();
    const session = await dshRuntime.session({ via: "executable", command: fake.script } as never, {
      cwd: fake.dir,
      model: "deepseek-flash",
      effort: "low",
    });
    await session.prompt("hi");
    await session.dispose();
    const logged = await onDisk((fs) => fs.readFileString(fake.log));
    const requests = await Effect.runPromise(Effect.forEach(logged.trim().split("\n"), (l) => Schema.decodeEffect(LoggedRequest)(l)));
    const values = requests.filter((e) => e.method === "session/set_config_option").map((e) => `${e.params.configId}=${e.params.value}`);
    expect(values).toContain(`model=["deepseek-official","deepseek-flash"]`);
    expect(values).toContain("reasoning_effort=low");
  });

  it("lists the models of a throwaway session", async () => {
    const fake = await fakeDsh();
    const listed = await dshRuntime.listModels({ via: "executable", command: fake.script } as never, { cwd: fake.dir });
    expect(listed.kind === "ok" && listed.models.map((m) => m.id)).toEqual(["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"]);
  });

  it("refuses a system prompt", async () => {
    await expect(
      dshRuntime.session({ via: "executable", command: "/nonexistent" } as never, {
        cwd: tmpdir(),
        systemPrompt: "x",
      }),
    ).rejects.toThrow();
  });
});
