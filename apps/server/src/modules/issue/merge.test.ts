import { expect, test } from "vite-plus/test";

import { finishesWithPullRequest } from "./merge.ts";

test("a followed pull request's end finishes an open issue that delivers by merging", () => {
  expect(finishesWithPullRequest({ deliver: "change" })).toBe(true);
  expect(finishesWithPullRequest({ deliver: "change", closedAt: 1 })).toBe(false);
  expect(finishesWithPullRequest({ deliver: "pull_request" })).toBe(false);
});
