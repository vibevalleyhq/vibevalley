import { describe, expect, it } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { Assignments } from "./assignment.ts";

describe("assignment history", () => {
  it("regression: a delayed committed snapshot cannot revive an ended responsibility", () => {
    const assignments = new Assignments();
    const issue = issueId("i1");
    const first = { id: "a1", issue, agent: "lab", assigned_at: 1, ended_at: null };
    assignments.changed([
      { ...first, ended_at: 2 },
      { ...first, id: "a2", agent: "lab2", assigned_at: 2 },
    ]);
    assignments.changed([first]);
    expect(assignments.of(issue).map((a) => [a.id, a.endedAt])).toEqual([
      ["a1", 2],
      ["a2", undefined],
    ]);
  });
});
