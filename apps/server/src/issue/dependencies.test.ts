import { expect, test } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { blockedIssues, dependencyProblems } from "./dependencies.ts";

test("regression: a child cannot wait for the parent that must wait for it", () => {
  const parent = issueId("parent");
  const child = issueId("child");
  expect(
    dependencyProblems([
      { id: parent, blockedBy: [] },
      { id: child, parent, blockedBy: [parent] },
    ]),
  ).toEqual([{ kind: "circle", circle: [parent, child] }]);
  expect(
    dependencyProblems([
      { id: parent, blockedBy: [] },
      { id: child, parent, blockedBy: [] },
    ]),
  ).toEqual([]);
});

test("dependencies release only when completed or canceled; missing issues remain blocking", () => {
  const ids = ["done", "canceled", "review", "missing"].map(issueId);
  expect(
    blockedIssues({ blockedBy: ids }, [
      { id: ids[0]!, status: "done" },
      { id: ids[1]!, status: "canceled" },
      { id: ids[2]!, status: "in_review" },
    ]),
  ).toEqual(ids.slice(2));
});
