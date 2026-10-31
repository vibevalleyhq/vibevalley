import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { endpoints, kebab, pathOf } from "@vibevalley/protocol/api";
import { Preview } from "@vibevalley/protocol/schema";

import { lookIn, memoriesOf } from "./errors.ts";
import { cli, farm } from "./testing/cli.ts";

describe("the command line", () => {
  it.effect("has a command, with its help, for every endpoint", () =>
    Effect.gen(function* () {
      for (const e of endpoints) {
        const help = yield* cli([...e.op.split(".").map(kebab), "--help"]);
        expect({ op: e.op, code: help.code }).toEqual({ op: e.op, code: 0 });
        expect(help.out).toContain(`POST ${pathOf(e.op)}`);
      }
    }),
  );

  it.live("calls an endpoint and prints its answer as one JSON document", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const made = yield* cli(["issue", "create", "--server", server, "--json", JSON.stringify({ title: "试一下" })]);
      expect([made.code, made.out.split("\n").length]).toEqual([0, 1]);
      const issue = JSON.parse(made.out) as { id: string; number: number; status: string };
      expect(issue.status).toBe("backlog");
      // The issue's number is enough, as the server takes it, and the body can come on stdin.
      const got = JSON.parse((yield* cli(["issue", "get", String(issue.number), "--server", server])).out) as { title: string };
      expect(got.title).toBe("试一下");
      const edited = yield* cli(["issue", "update", issue.id, "--server", server, "--json", "-"], JSON.stringify({ title: "改一下" }));
      expect((JSON.parse(edited.out) as { title: string }).title).toBe("改一下");
      const list = JSON.parse((yield* cli(["issue", "list", "--server", server])).out) as { id: string }[];
      expect(list.map((i) => i.id)).toContain(issue.id);
      expect(JSON.parse((yield* cli(["state", "--server", server])).out)).toHaveProperty("state");
      // With no --server, VIBEVALLEY_SERVER says where.
      const fromEnv = yield* cli(["issue", "get", issue.id], "", { VIBEVALLEY_SERVER: server });
      expect([fromEnv.code, (JSON.parse(fromEnv.out) as { title: string }).title]).toEqual([0, "改一下"]);
    }),
  );

  it.live("fails with nothing on stdout, a JSON failure on stderr and an exit code by kind", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const missingArgument = yield* cli(["issue", "get", "--server", server]);
      expect([missingArgument.code, missingArgument.out, missingArgument.failure?.tag]).toEqual([2, "", "MissingArgument"]);
      expect(missingArgument.failure?.next).toEqual([{ say: "看这条命令怎么写", run: ["issue", "get", "--help"] }]);
      const unknownFlag = yield* cli(["issue", "list", "--bogus", "1", "--server", server]);
      expect([unknownFlag.code, unknownFlag.failure?.tag]).toEqual([2, "UnrecognizedOption"]);
      // A body its endpoint does not take never leaves: the wrong field is named.
      const wrongBody = yield* cli(["issue", "create", "--server", server, "--json", JSON.stringify({ title: 1 })]);
      expect([wrongBody.code, wrongBody.failure?.tag]).toEqual([2, "InvalidValue"]);
      expect(wrongBody.failure?.message).toContain("title");
      const notJson = yield* cli(["issue", "create", "--server", server, "--json", "{"]);
      expect([notJson.code, notJson.failure?.tag]).toEqual([2, "InvalidJson"]);
      const missing = yield* cli(["issue", "get", "nope", "--server", server]);
      expect([missing.code, missing.out, missing.failure?.tag]).toEqual([4, "", "Missing"]);
      const made = JSON.parse((yield* cli(["issue", "create", "--server", server, "--json", JSON.stringify({ title: "派不出去" })])).out) as { id: string };
      const refused = yield* cli(["issue", "status", "update", made.id, "--server", server, "--json", JSON.stringify({ status: "done" })]);
      expect([refused.code, refused.out, refused.failure?.tag]).toEqual([3, "", "Refused"]);
      // The refusal says what can be done instead, as commands that run as they are.
      const cancel = refused.failure?.next?.find((n) => n.run?.includes('{"status":"canceled"}') === true);
      expect(cancel?.run).toBeDefined();
      const canceled = yield* cli([...cancel!.run!, "--server", server]);
      expect([canceled.code, (JSON.parse(canceled.out) as { status: string }).status]).toEqual([0, "canceled"]);
      const nowhere = yield* cli(["issue", "get", "nope", "--server", server]);
      expect(nowhere.failure?.next).toEqual([{ say: "列出工单，找它的编号", run: ["issue", "list"] }]);
      const unreachable = yield* cli(["issue", "list", "--server", "http://127.0.0.1:9"]);
      expect([unreachable.code, unreachable.failure?.tag]).toEqual([5, "Unreachable"]);
    }),
  );

  // A dry run is an endpoint of its own that takes what the real one takes, so --dry-run can call it with the same words.
  it("gives each command that changes what cannot be taken back a dry run of the same shape", () => {
    for (const e of endpoints.filter((x) => x.dryRun)) {
      const preview = endpoints.find((x) => x.op === e.dryRun);
      expect({ op: e.op, preview: preview?.op }).toEqual({ op: e.op, preview: e.dryRun });
      expect([preview!.about, preview!.input === e.input, preview!.result === Preview, preview!.can]).toEqual([e.about, true, true, e.can]);
    }
    // Every delete has one.
    expect(endpoints.filter((e) => e.op.endsWith(".delete") && !e.dryRun).map((e) => e.op)).toEqual([]);
  });

  it.live("--dry-run says what a command would do and changes nothing; one with no dry run is refused, a read runs", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const made = JSON.parse((yield* cli(["issue", "create", "--server", server, "--json", JSON.stringify({ title: "先试跑" })])).out) as {
        id: string;
        number: number;
      };
      const preview = yield* cli(["issue", "delete", made.id, "--server", server, "--dry-run"]);
      expect([preview.code, (JSON.parse(preview.out) as { does: string[] }).does[0]]).toEqual([0, `删掉工单 #${made.number}「先试跑」`]);
      expect((yield* cli(["issue", "get", made.id, "--server", server])).code).toBe(0);
      const cancel = yield* cli(["issue", "status", "update", made.id, "--server", server, "--dry-run", "--json", JSON.stringify({ status: "canceled" })]);
      expect((JSON.parse(cancel.out) as { does: string[] }).does).toEqual([`#${made.number} 关成已取消：还没派过`]);
      expect((JSON.parse((yield* cli(["issue", "get", made.id, "--server", server])).out) as { status: string }).status).toBe("backlog");
      // Refused as the real move would be, with the same words.
      const real = yield* cli(["issue", "status", "update", made.id, "--server", server, "--json", JSON.stringify({ status: "done" })]);
      const dry = yield* cli(["issue", "status", "update", made.id, "--server", server, "--dry-run", "--json", JSON.stringify({ status: "done" })]);
      expect([dry.code, dry.failure?.message]).toEqual([3, real.failure?.message]);
      const create = yield* cli(["issue", "create", "--server", server, "--dry-run", "--json", JSON.stringify({ title: "不该建" })]);
      expect([create.code, create.failure?.tag]).toEqual([2, "NoDryRun"]);
      const list = yield* cli(["issue", "list", "--server", server, "--dry-run"]);
      expect(list.code).toBe(0);
      expect((JSON.parse(list.out) as { title: string }[]).some((i) => i.title === "不该建")).toBe(false);
    }),
  );

  it.live("each delete's dry run names what it would delete and leaves it there; one that is not there is missing", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const run = (args: string[], body?: unknown) => cli([...args, "--server", server, ...(body === undefined ? [] : ["--json", JSON.stringify(body)])]);
      const doc = (r: { out: string }) => JSON.parse(r.out) as { id: string; does: string[] } & Record<string, unknown>;
      const list = (args: string[]) => Effect.map(run(args), (r) => JSON.parse(r.out) as unknown);

      const cron = doc(yield* run(["cron", "create"], { name: "早上看看", text: "看看昨天的改动", when: { kind: "daily", time: "09:00" } }));
      expect(doc(yield* run(["cron", "delete", cron.id, "--dry-run"])).does[0]).toContain("删掉定时任务「早上看看」");
      expect(JSON.stringify(yield* list(["cron", "list"]))).toContain(cron.id);

      const skill = doc(yield* run(["skill", "create"], { id: "", name: "写测试", description: "先写测试", body: "先写测试再改" }));
      const agents = (yield* list(["agent", "list"])) as { id: string; name: string }[];
      const docs = agents.find((a) => a.id === "docs")!;
      yield* run(["agent", "update", "docs"], { ...docs, skills: [skill.id] });
      expect(doc(yield* run(["skill", "delete", skill.id, "--dry-run"])).does).toEqual(["删掉技能「写测试」", `从 「${docs.name}」 的档案里摘掉它`]);
      expect(JSON.stringify(yield* list(["skill", "list"]))).toContain(skill.id);

      expect(doc(yield* run(["agent", "delete", "docs", "--dry-run"])).does[0]).toContain(`删掉档案「${docs.name}」`);
      expect(JSON.stringify(yield* list(["agent", "list"]))).toContain('"id":"docs"');
      const orchestrator = yield* run(["agent", "delete", "orchestrator", "--dry-run"]);
      expect([orchestrator.code, orchestrator.failure?.message]).toEqual([3, "默认管家删不了：至少要有一个管家"]);

      const memory = doc(yield* run(["memory", "create", "docs"], { text: "主人喜欢短的提交说明" }));
      expect(doc(yield* run(["memory", "delete", "docs", memory.id, "--dry-run"])).does).toEqual([`从 docs 的记性里忘掉：「主人喜欢短的提交说明」`]);
      expect(JSON.stringify(yield* list(["memory", "list", "docs"]))).toContain(memory.id);

      expect(doc(yield* run(["lan", "pairing", "stop", "--dry-run"])).does).toEqual(["没有在配对的码：什么都不会动"]);

      // Not there: the delete and its dry run are both missing, and say where to look.
      for (const args of [
        ["agent", "delete", "nobody"],
        ["skill", "delete", "nothing"],
        ["cron", "delete", "never"],
        ["memory", "delete", "docs", "nothing"],
        ["lan", "device", "delete", "nowhere"],
      ]) {
        const dry = yield* run([...args, "--dry-run"]);
        const real = yield* run(args);
        expect([args.join(" "), dry.code, real.code, dry.failure?.message === real.failure?.message]).toEqual([args.join(" "), 4, 4, true]);
        expect(dry.failure?.next?.[0]?.run).toBeDefined();
      }
    }),
  );

  it.effect("every place a missing thing points to is a command that is there", () =>
    Effect.gen(function* () {
      for (const next of [...Object.values(lookIn), memoriesOf("docs")]) {
        if (!next.run) continue;
        const help = yield* cli([...next.run, "--help"]);
        expect({ run: next.run, code: help.code }).toEqual({ run: next.run, code: 0 });
      }
    }),
  );

  it.effect("asked for help, prints it on stdout; given a mistake, keeps stdout empty", () =>
    Effect.gen(function* () {
      const help = yield* cli(["issue", "--help"]);
      expect(help.code).toBe(0);
      expect(help.out).toContain("status");
      expect(help.err).toBe("");
      const wrong = yield* cli(["issue", "nope"]);
      expect([wrong.code, wrong.out, wrong.failure?.tag]).toEqual([2, "", "UnknownSubcommand"]);
    }),
  );
});
