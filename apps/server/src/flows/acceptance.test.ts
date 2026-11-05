import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Agent } from "#/agent/agent.ts";
import { Issue } from "#/issue/issue.ts";
import { Project } from "#/project/project.ts";
import { gitSync } from "#/testing/git.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab } from "./farm.ts";

for (const mode of ["pass", "frozen", "failed"] as const) {
  it.live(
    `regression: native child acceptance ${mode === "pass" ? "passes before merging into the parent" : mode === "frozen" ? "rejects changes to frozen tests" : "rejects an implementation that fails the inherited check"}`,
    () => {
      const f = farm({
        runtime: scriptedRuntime({
          id: "pi",
          turn: async (turn) => {
            if (!existsSync(join(turn.options.cwd, "check.sh"))) writeFileSync(join(turn.options.cwd, "check.sh"), "test -f result.txt\n");
            else {
              if (mode !== "failed") writeFileSync(join(turn.options.cwd, "result.txt"), "implementation");
              else writeFileSync(join(turn.options.cwd, "unrelated.txt"), "not implemented");
              if (mode === "frozen") writeFileSync(join(turn.options.cwd, "check.sh"), "true\n");
            }
            gitSync(turn.options.cwd, "add", ".");
            gitSync(turn.options.cwd, "commit", "-m", "Implement assigned child");
            turn.say("finished");
          },
        }),
      });
      return Effect.gen(function* () {
        const issues = testIssues(yield* Issue);
        yield* (yield* Agent).save(lab());
        const parent = yield* issues.add({ title: "parent", agent: "lab", project: "acceptance" });
        const acceptance = yield* issues.add({
          title: "seed-red-test",
          parent: parent.id,
          constraints: { acceptance: true, check: "sh check.sh", scope: ["check.sh"], frozen: [] },
        });
        const implementation = yield* issues.add({ title: "implement", parent: parent.id, blockedBy: [acceptance.id] });
        yield* issues.start(acceptance.id, "");
        const red = yield* await_(
          () => issues.get(acceptance.id),
          (item) => item.status === "done",
          "the red acceptance test merged",
        );
        expect(red.constraints?.frozen).toEqual(["check.sh"]);
        yield* issues.start(implementation.id, "");
        const result = yield* await_(
          () => issues.get(implementation.id),
          (item) => (mode === "pass" ? item.status === "done" : item.questions.length > 0),
          "the implementation verified",
        );
        const place = yield* (yield* Project).workplace("acceptance", parent.number, true, "");
        expect(readFileSync(join(place.cwd, "check.sh"), "utf8")).toBe("test -f result.txt\n");
        if (mode === "pass") {
          expect(result.delivered).toBe("merged_into_parent");
          expect(readFileSync(join(place.cwd, "result.txt"), "utf8")).toBe("implementation");
        } else {
          expect(result.delivered).toBeUndefined();
          expect(result.questions[0]?.question).toContain(mode === "frozen" ? "check.sh" : "sh check.sh");
        }
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );
}
