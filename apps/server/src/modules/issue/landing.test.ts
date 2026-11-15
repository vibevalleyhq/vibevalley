import { expect, test } from "vite-plus/test";

import { finishesWithPullRequest, goesByPullRequest, landingRouteOf } from "./landing.ts";
import { conflictOf } from "./status.ts";

const open = { url: "https://github.com/o/r/pull/1", number: 1, state: "open" } as const;

test("an issue's work goes in from its own checkout, its helper's workplace, or not at all", () => {
  const here = { last: "w1", reachable: true };
  const gone = { last: "w1", reachable: false };
  const never = { last: undefined, reachable: false };
  expect(landingRouteOf({ repo: "demo" }, gone, true, false)).toEqual({ kind: "checkout", repo: "demo" });
  expect(landingRouteOf({ repo: "demo" }, never, true, false)).toEqual({ kind: "checkout", repo: "demo" });
  expect(landingRouteOf({ repo: "demo" }, here, true, false)).toEqual({ kind: "merge", session: "w1" });
  expect(landingRouteOf({}, never, true, false)).toEqual({ kind: "notStarted" });
  expect(landingRouteOf({ repo: "demo" }, gone, false, false)).toEqual({ kind: "helperGone", session: "w1" });
  expect(landingRouteOf({ repo: "demo" }, here, false, true)).toEqual({ kind: "pullRequest", session: "w1" });
  expect(landingRouteOf({ repo: "demo", pullRequest: open }, here, false, false)).toEqual({ kind: "pullRequest", session: "w1" });
  expect(landingRouteOf({}, here, false, true)).toEqual({ kind: "merge", session: "w1" });
});

test("a pull request carries the work when one is open or the repo goes by them", () => {
  expect(goesByPullRequest({}, false)).toBe(false);
  expect(goesByPullRequest({}, true)).toBe(true);
  expect(goesByPullRequest({ pullRequest: open }, false)).toBe(true);
  expect(goesByPullRequest({ pullRequest: { ...open, state: "merged" } }, false)).toBe(false);
});

test("a followed pull request's end finishes an open issue that delivers by merging", () => {
  expect(finishesWithPullRequest({ deliver: "change" })).toBe(true);
  expect(finishesWithPullRequest({ deliver: "change", closedAt: 1 })).toBe(false);
  expect(finishesWithPullRequest({ deliver: "pull_request" })).toBe(false);
});

test("reads a conflict off a preview", () => {
  expect(conflictOf({ base: "main", conflicts: [] })).toBeUndefined();
  expect(conflictOf({ base: "main", conflicts: ["a.ts"] })).toEqual({ base: "main", files: ["a.ts"] });
});
