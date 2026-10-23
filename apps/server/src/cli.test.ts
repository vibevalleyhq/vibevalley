import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { endpoints } from "@vibevalley/protocol/api";
import { kebab } from "./cli/api.ts";
import { run } from "./cli.ts";
import { app } from "./http/app.ts";
import { testConfig } from "./testing/layers.ts";

/** The whole farm on a free port; the command line is pointed at it. */
const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a))));
  return "http://" + address;
});

/** One run: its exit code, what it put on stdout and on stderr, and the failure stderr ends with. */
const cli = (args: string[], stdin = "") =>
  Effect.gen(function* () {
    const out: string[] = [];
    const err: string[] = [];
    const code = yield* run(args, { out: (s) => void out.push(s), err: (s) => void err.push(s), tty: false, stdin: async () => stdin, env: {} });
    const last = err.join("\n").split("\n").at(-1) ?? "";
    const failure = last.startsWith('{"error"')
      ? (JSON.parse(last) as { error: { tag: string; message: string; next?: { say: string; run?: string[] }[] } }).error
      : undefined;
    return { code, out: out.join("\n"), err: err.join("\n"), failure };
  });

describe("the command line", () => {
  it.effect("has a command, with its help, for every endpoint", () =>
    Effect.gen(function* () {
      for (const e of endpoints) {
        const [group, op] = e.op.split(".") as [string, string];
        const help = yield* cli([group, kebab(op), "--help"]);
        expect({ op: e.op, code: help.code }).toEqual({ op: e.op, code: 0 });
        expect(help.out).toContain(`${e.method} ${e.path}`);
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
      const refused = yield* cli(["issue", "status", made.id, "--server", server, "--json", JSON.stringify({ status: "done" })]);
      expect([refused.code, refused.out, refused.failure?.tag]).toEqual([3, "", "Refused"]);
      // The refusal says what can be done instead, as commands that run as they are.
      const cancel = refused.failure?.next?.find((n) => n.run?.includes('{"status":"canceled"}'));
      expect(cancel?.run).toBeDefined();
      const canceled = yield* cli([...cancel!.run!, "--server", server]);
      expect([canceled.code, (JSON.parse(canceled.out) as { status: string }).status]).toEqual([0, "canceled"]);
      const nowhere = yield* cli(["issue", "get", "nope", "--server", server]);
      expect(nowhere.failure?.next).toEqual([{ say: "列出工单，找它的编号", run: ["issue", "list"] }]);
      const unreachable = yield* cli(["issue", "list", "--server", "http://127.0.0.1:9"]);
      expect([unreachable.code, unreachable.failure?.tag]).toEqual([5, "Unreachable"]);
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
