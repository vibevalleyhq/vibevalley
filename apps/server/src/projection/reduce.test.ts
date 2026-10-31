import { expect, it } from "vite-plus/test";

import type { FactCall, Issue } from "@vibevalley/protocol";

import { emptyWorkspaceState } from "@/core/core.ts";

import { reduce } from "./reduce.ts";

it("a fact that changes neither issues nor sessions leaves the issues' statuses alone", () => {
  const issue = { id: "t1", status: "in_review", sessions: [], attention: { state: "reviewing", acts: [] } } as unknown as Issue;
  const state = { ...emptyWorkspaceState(), issues: [issue] };
  const fact: FactCall = { type: "call", at: 1, state: "live", reason: "x" };
  const [next, changed] = reduce(state, fact);
  expect(changed).toBe(true);
  expect(next.issues).toBe(state.issues);
  expect(next.sessions).toBe(state.sessions);
});
