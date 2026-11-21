import { describe, expect, test } from "vite-plus/test";

import { regressionProblems, regressionTestsIn } from "./regression.ts";

const file = (body: string) => regressionTestsIn("a.test.ts", body);
const kept = `it("regression: the helper idle longest goes home", () => {\n  expect(goesHome(farm)).toBe("b");\n});`;
const weakened = `it("regression: the helper idle longest goes home", () => {\n  expect(goesHome(farm)).toBeDefined();\n});`;
const body = (...sections: string[]) => ["## What changed", "x", ...sections, "## Checks", "x", "## Not verified", "None."].join("\n\n");

describe("regression tests", () => {
  test("are found by name under every runner, with their whole call", () => {
    const found = file(
      [
        kept,
        `it.effect("regression: a cancelled answer does not start", () => Effect.void);`,
        "test(`regression: the call speaks`, async () => {});",
        `test.skip("regression: skipped still counts", () => {});`,
        `it("the board groups issues", () => {});`,
        `describe("regression: a describe is not a test", () => {});`,
      ].join("\n"),
    );
    expect([...found.keys()]).toEqual([
      "regression: the helper idle longest goes home",
      "regression: a cancelled answer does not start",
      "regression: the call speaks",
      "regression: skipped still counts",
    ]);
    // The call itself, without the statement's semicolon.
    expect(found.get("regression: the helper idle longest goes home")).toBe(kept.slice(0, -1));
  });

  test("changed or removed, they are named in the body's Regression section", () => {
    const before = file(kept);
    expect(regressionProblems({ before, after: file(weakened), branch: "feat/x", body: body() })).toHaveLength(1);
    expect(regressionProblems({ before, after: file(""), branch: "refactor/x", body: body() })).toHaveLength(1);
    expect(
      regressionProblems({
        before,
        after: file(weakened),
        branch: "feat/x",
        body: body("## Regression", "- `regression: the helper idle longest goes home`: who goes home is now the user's choice."),
      }),
    ).toEqual([]);
    expect(regressionProblems({ before, after: file(kept), branch: "feat/x", body: body() })).toEqual([]);
  });

  test("a section naming another test does not cover this one", () => {
    const problems = regressionProblems({ before: file(kept), after: file(""), branch: "feat/x", body: body("## Regression", "- `regression: other`") });
    expect(problems).toHaveLength(1);
  });

  test("a fix adds one, or says why it cannot", () => {
    expect(regressionProblems({ before: file(""), after: file(""), branch: "fix/x", body: body() })).toHaveLength(1);
    expect(regressionProblems({ before: file(""), after: file(kept), branch: "fix/x", body: body() })).toEqual([]);
    expect(
      regressionProblems({ before: file(""), after: file(""), branch: "fix/x", body: body("## Regression", "A look, checked by the screenshot below.") }),
    ).toEqual([]);
    expect(regressionProblems({ before: file(""), after: file(""), branch: "feat/x", body: body() })).toEqual([]);
  });

  test("finds Rust #[test] fn regression_* functions with their full body", () => {
    const rs = [
      "#[test]",
      "fn ordinary_case() { assert_eq!(1, 1); }",
      "",
      "#[test]",
      'fn regression_closing_window_keeps_app_alive() {\n    let s = "{ not a brace }";\n    assert!(!s.is_empty());\n}',
    ].join("\n");
    const found = regressionTestsIn("crates/server/tests/flow.rs", rs);
    expect([...found.keys()]).toEqual(["regression_closing_window_keeps_app_alive"]);
    expect(regressionProblems({ before: new Map(), after: found, branch: "fix/window-close", body: body() })).toEqual([]);
  });
});
