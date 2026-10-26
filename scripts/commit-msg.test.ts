import { expect, test } from "vite-plus/test";
import { bodyProblems, branchProblems, messageProblems, subjectMax, subjectProblems } from "./commit-msg";

test("a subject says what the code now does, in at most 100 characters", () => {
  expect(subjectProblems("The board groups issues by helper")).toEqual([]);
  expect(subjectProblems("The board groups issues ".repeat(5).slice(0, subjectMax).trim())).toEqual([]);
  expect(subjectProblems("x".repeat(subjectMax + 1))[0]).toContain("101 characters");
  expect(subjectProblems("")).toEqual(["the subject is empty"]);
  expect(subjectProblems(" The board groups issues")).toEqual(["the subject starts or ends with spaces"]);
  expect(subjectProblems("The board groups issues.")).toEqual(["drop the full stop at the end of the subject"]);
});

test("a body is set off by a blank line, and comments and the diff under the scissors are not the message", () => {
  expect(messageProblems("The board groups issues\n\nWhy and how.\n")).toEqual([]);
  expect(messageProblems("The board groups issues\nWhy and how.")).toEqual(["leave a blank line between the subject and the body"]);
  expect(messageProblems("# Please enter the commit message\nThe board groups issues\n")).toEqual([]);
  expect(
    messageProblems("The board groups issues\n# ------------------------ >8 ------------------------\nx".replace("x", "diff\n" + "y".repeat(200))),
  ).toEqual([]);
  expect(messageProblems("# only comments\n")).toEqual(["the subject is empty"]);
});

test("no agent signs the commit", () => {
  expect(messageProblems("The board groups issues\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toHaveLength(1);
  expect(messageProblems("The board groups issues\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toHaveLength(1);
  expect(messageProblems("The board groups issues\n\nCo-Authored-By: A teammate <a@example.com>")).toEqual([]);
});

test("what git writes itself passes as it is", () => {
  expect(messageProblems("Merge pull request #1 from vibevalleyhq/typescript-everywhere\n")).toEqual([]);
  expect(messageProblems(`Revert "${"x".repeat(120)}"\n`)).toEqual([]);
  expect(messageProblems("fixup! The board groups issues\n")).toEqual([]);
});

test("a subject is English; the interface's words and code are quoted", () => {
  expect(subjectProblems("工单板按帮工分组")[0]).toContain("write the subject in English");
  expect(subjectProblems("The board groups issues by helper，按帮工")[0]).toContain("按帮工");
  expect(subjectProblems("The board's 「完成」 column keeps `已完成` issues")).toEqual([]);
});

test("a pull request's body has the template's sections, in English", () => {
  const body = (what: string) => `## What changed\n\n${what}\n\n## Checks\n\n- \`bun run check\`\n\n## Not verified\n\nNone.\n`;
  expect(bodyProblems(body("The board groups issues by helper."))).toEqual([]);
  expect(bodyProblems(body("A full gateway says 「网关满了」.\n\n```\nexpected '还在等' to be '收到'\n```"))).toEqual([]);
  expect(bodyProblems(body("<!-- 模板的注释不算 -->\nThe board groups issues."))).toEqual([]);
  expect(bodyProblems(body("工单板按帮工分组。"))[0]).toContain("write the body in English");
  expect(bodyProblems("## Changes\n\nThe board groups issues.")).toEqual([
    'the body has no "## What changed" section',
    'the body has no "## Checks" section',
    'the body has no "## Not verified" section',
  ]);
});

test("a branch is <kind>/<topic> in lowercase English", () => {
  for (const ok of ["feat/issue-board-groups", "fix/lan-retry", "test/connector-receive", "docs/acceptance"]) expect(branchProblems(ok)).toEqual([]);
  expect(branchProblems("feature/issue-board")[0]).toContain("one of feat");
  for (const bad of ["v4-k31", "fix/Issue_Board", "fix/修", "fix/a/b", "fix/-x"]) expect(branchProblems(bad)[0]).toContain("<kind>/<topic>");
});
