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
  test(`regression: ${op} rejects invalid enum ${JSON.stringify(input)} before running`, async () => {
    let ran = false;
    const entry = tool(op, () => ((ran = true), "ran"));
    const result = await entry.execute(input, { id: "audit" }).then(
      () => "succeeded",
      () => "failed",
    );
    expect(result).toBe("failed");
    expect(ran).toBe(false);
  });
}

test("omitted tool enums stay omitted and accepted aliases become protocol values", () => {
  const create = (v: unknown) => parameters["issue.create"].parse(v);
  const list = (v: unknown) => parameters["issue.list"].parse(v);
  expect(create({ title: "audit" })).toEqual({ title: "audit" });
  expect(list({})).toEqual({});
  expect(create({ title: "audit", priority: " high " })).toEqual({ title: "audit", priority: "high" });
  expect(create({ title: "audit", priority: "高" })).toEqual({ title: "audit", priority: "high" });
  expect(list({ status: " done " })).toEqual({ status: "done" });
  expect(list({ status: "完成" })).toEqual({ status: "done" });
});
