import { expect, test } from "vite-plus/test";
import { messageProblems, subjectMax, subjectProblems } from "./commit-msg";

test("a subject says what the code now does, in at most 100 characters", () => {
  expect(subjectProblems("The board groups issues by helper")).toEqual([]);
  expect(subjectProblems("工单板按帮工分组：".repeat(11).slice(0, subjectMax))).toEqual([]);
  expect(subjectProblems("工".repeat(subjectMax + 1))[0]).toContain("101 characters");
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
