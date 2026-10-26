// The command line's recorded answers (testdata/cli.jsonl.gz): the help of the root, every group and a few commands, and
// what typical mistakes, refusals and dry runs print, exit code and all. A command added, renamed or reworded shows up
// as a diff here; `vp run golden:update cli` writes the new answers back, to be read before kept.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { cli, farm } from "../testing/cli.ts";

const cases = goldenCases("cli", "cli.jsonl.gz");

describe("the command line's answers", () => {
  it.live("are what they were", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      // The one issue the cases refuse and dry-run: #1 in a farm of its own.
      expect((yield* cli(["issue", "create", "--server", server, "--json", JSON.stringify({ title: "派不出去" })])).code).toBe(0);
      const answers = new Map<number, unknown>();
      for (const c of cases) {
        const args = c.in as string[];
        const at = args.includes("--server") ? args : [...args, "--server", server];
        switch (c.fn) {
          case "help": {
            const r = yield* cli([...args, "--help"]);
            answers.set(c.line, { code: r.code, help: r.out.split("\n") });
            break;
          }
          case "fail": {
            const r = yield* cli(at);
            answers.set(c.line, { code: r.code, out: r.out, error: r.failure });
            break;
          }
          case "dry": {
            const r = yield* cli([...at, "--dry-run"]);
            answers.set(c.line, { code: r.code, out: r.out === "" ? null : (JSON.parse(r.out) as unknown), error: r.failure });
            break;
          }
          default:
            throw new Error(`no such case: ${c.fn}`);
        }
      }
      expect(checkCases(cases, (c) => answers.get(c.line))).toEqual([]);
    }),
  );
});
