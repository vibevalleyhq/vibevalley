import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { type TriggerInput, triggerOf } from "#/modules/session/payload.ts";
import { testDb } from "#/testing/layers.ts";
import { moduleWorld } from "#/testing/world.ts";
import * as cursor from "#db/issue_github_cursor.sql.ts";
import * as qe from "#db/issue_github_event.sql.ts";
import { allOpenDeliveries } from "#db/session_delivery.sql.ts";

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

const review: TriggerInput = {
  source: "github",
  key: "repo#7:review:42",
  actor: { kind: "system", id: "reviewer" },
  text: "original review",
  data: { detail: "original" },
  threads: ["github:repo#7"],
  addressed: "thread_owner",
  meta: { repo: "repo", pr: 7, botRound: 1, botRoundKey: "round-1" },
  at: 10,
};

test("regression: the source cursor and Mailbox trigger share commit and rollback without routing", async () => {
  await using farm = await moduleWorld();
  const { inside: mailbox, db, core } = farm;
  const state = core.state();
  const scope = { repo: "repo", pr_number: 7 };
  const id = triggerOf(review).id;
  await cursor.ensureGitHubCursor(db.sql, scope);
  const write = async () => {
    await cursor.observeGitHubChecks(db.sql, { ...scope, check_fingerprint: "changed", check_revision: 1 });
    return mailbox.recordTrigger(review);
  };
  const rolledBack = await db
    .tx(async () => {
      await write();
      throw new Error("rollback");
    })
    .then(
      () => "committed",
      () => "failed",
    );
  expect(rolledBack).toBe("failed");
  const trigger2 = await mailbox.readTrigger(id);
  expect(trigger2).toBeUndefined();
  expect((await cursor.gitHubCursor(db.sql, scope))?.check_revision).toBe(0);
  const trigger = await db.tx(write);
  expect((await cursor.gitHubCursor(db.sql, scope))?.check_revision).toBe(1);
  expect((await mailbox.readTrigger(id))?.trigger).toEqual(trigger);
  const registered2 = await mailbox.isRouted(id);
  expect(registered2).toBe(false);
  const allOpenDeliveries2 = await allOpenDeliveries(db.sql);
  expect(allOpenDeliveries2).toEqual([]);
  expect(mailbox.deliveriesOf(defaultOrchestrator)).toEqual([]);
  expect(core.state()).toBe(state);
});
