import { expect, test } from "vite-plus/test";

import { testDb } from "#/testing/layers.ts";
import * as qe from "#db/issue_github_event.sql.ts";

import { checksVerdict } from "./github.ts";

const check = (status: string, conclusion = "") => ({ name: status + conclusion, status, conclusion });

test("a pull request's checks: the failed ones, and whether all have finished", () => {
  expect(checksVerdict([])).toEqual({ failed: [], finished: false });
  expect(checksVerdict([check("IN_PROGRESS"), check("COMPLETED", "SUCCESS")])).toEqual({ failed: [], finished: false });
  expect(checksVerdict([check("COMPLETED", "SUCCESS"), check("success")])).toEqual({ failed: [], finished: true });
  const failed = check("COMPLETED", "failure");
  expect(checksVerdict([failed, check("QUEUED")])).toEqual({ failed: [failed], finished: false });
  expect(checksVerdict([check("TIMED_OUT")]).failed).toHaveLength(1);
});

test("regression: a GitHub event kept twice keeps its first bot round", async () => {
  await using db = await testDb();
  await qe.keepGitHubEvent(db.sql, { repo: "repo", pr_number: 7, key: "review:R1", bot_round_key: "round-1", bot_round: 1 });
  await qe.keepGitHubEvent(db.sql, { repo: "repo", pr_number: 7, key: "review:R1", bot_round_key: "round-2", bot_round: 2 });
  expect(await qe.knownGitHubEvents(db.sql, { repo: "repo", pr_number: 7 })).toEqual([{ key: "review:R1", bot_round_key: "round-1", bot_round: 1 }]);
});
