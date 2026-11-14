import { expect, test } from "vite-plus/test";

import { finishesWithPullRequest } from "./merge.ts";
import { conflictOf } from "./status.ts";

test("a followed pull request's end finishes an open issue that delivers by merging", () => {
  expect(finishesWithPullRequest({ deliver: "change" })).toBe(true);
  expect(finishesWithPullRequest({ deliver: "change", closedAt: 1 })).toBe(false);
  expect(finishesWithPullRequest({ deliver: "pull_request" })).toBe(false);
});

test("reads a conflict off a preview", () => {
  expect(conflictOf({ base: "main", conflicts: [] })).toBeUndefined();
  expect(conflictOf({ base: "main", conflicts: ["a.ts"] })).toEqual({ base: "main", files: ["a.ts"] });
});
