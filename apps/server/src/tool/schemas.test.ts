import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { parameters, tool } from "./schemas.ts";

for (const [op, input] of [
  ["issue.create", { title: "audit", priority: "invalid" }],
  ["issue.update", { id: "1", priority: "invalid" }],
  ["issue.list", { status: "invalid" }],
  ["issue.status.update", { id: "1", status: "invalid" }],
  ["issue.create", { title: "audit", priority: "" }],
  ["issue.list", { status: "constructor" }],
] as const) {
  it.effect(`regression: ${op} rejects invalid enum ${JSON.stringify(input)} before running`, () =>
    Effect.gen(function* () {
      let ran = false;
      const entry = tool(op, () => Effect.sync(() => ((ran = true), "ran")));
      const result = yield* Effect.exit(entry.execute(input, { id: "audit" }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(ran).toBe(false);
    }),
  );
}

test("omitted tool enums stay omitted and accepted aliases become protocol values", () => {
  const create = Schema.decodeUnknownSync(parameters["issue.create"]);
  const list = Schema.decodeUnknownSync(parameters["issue.list"]);
  expect(create({ title: "audit" })).toEqual({ title: "audit" });
  expect(list({})).toEqual({});
  expect(create({ title: "audit", priority: " high " })).toEqual({ title: "audit", priority: "high" });
  expect(create({ title: "audit", priority: "\u9ad8" })).toEqual({ title: "audit", priority: "high" });
  expect(list({ status: " done " })).toEqual({ status: "done" });
  expect(list({ status: "\u5b8c\u6210" })).toEqual({ status: "done" });
});
