import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { issueScopeOf } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { starter, testDb, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import { inputsOfIssue, pendingIssueInputs } from "#db/issue_input.sql.ts";

test("regression: reassignment selects unread inputs without loading consumed history", async () => {
  await using db = await testDb();
  const work = issueId("work");
  const sql = (text: TemplateStringsArray) => db.sql.exec(text.join(""));
  await sql`insert into issue (id, number, description, mandate_strength, max_bot_review_rounds, auto_submit_pr, created_at)
      values ('work', 1, '', 'explicit', 3, false, 0)`;
  await sql`insert into session (id, role, agent, name, runtime, brief, hired_at)
      values ('old', 'worker', 'lab', 'lab', 'pi', '', 0)`;
  await sql`insert into session_trigger (id, source, source_key, actor_kind, trigger_json, payload_json, occurred_at, routed_at, routing_scope, routing_position)
      select n, 'github', n, 'user', '{"actor":{"kind":"user"}}', '{}', 0, 0, 'issue:work', n
      from (with recursive s(n) as (select 1 union all select n + 1 from s where n < 2007) select n from s)`;
  await sql`insert into issue_input (trigger_id, issue_id, state, session_id, created_at)
      select n, 'work', 'forwarded', 'old', 0 from (with recursive s(n) as (select 1 union all select n + 1 from s where n < 2007) select n from s)`;
  await sql`insert into session_delivery (session_id, envelope_id, trigger_id, actor_kind, scope, source, urgency, reason, wakes, state, payload_json, created_at)
      select 'old', n, n, 'user', 'issue:work', 'github', 'queue', 'addressed', true, 'consumed', '{}', 0
      from (with recursive s(n) as (select 1 union all select n + 1 from s where n < 2006) select n from s)`;
  await sql`update session_delivery set state = 'pending' where envelope_id = '2001'`;
  await sql`update session_delivery set state = 'handed', launch = 'run' where envelope_id = '2002'`;
  await sql`update session_delivery set state = 'dropped', dropped_why = 'left' where envelope_id = '2003'`;
  await sql`update session_delivery set state = 'dropped', dropped_why = 'reassigned' where envelope_id = '2004'`;
  await sql`update session_delivery set state = 'dropped', dropped_why = 'deleted' where envelope_id = '2005'`;
  await sql`update issue_input set state = 'held', session_id = null where trigger_id = '2006'`;
  const selected = async (recipient: string | null, closing = false) =>
    (await pendingIssueInputs(db.sql, { issue_id: work, recipient: recipient ? sessionId(recipient) : null, closing })).map((row) => row.trigger_id);
  const selected2 = await selected("new");
  expect(selected2).toEqual(["2001", "2002", "2003", "2004", "2006", "2007"]);
  const selected3 = await selected("old");
  expect(selected3).toEqual(["2006"]);
  const selected4 = await selected(null);
  expect(selected4).toEqual(["2006"]);
  const selected5 = await selected(null, true);
  expect(selected5).toEqual(["2001", "2002", "2003", "2004", "2005", "2006", "2007"]);
  const issueInputs2 = await inputsOfIssue(db.sql, { issue_id: work });
  expect(issueInputs2).toHaveLength(2007);
});

test("regression: a new held cron input supersedes only prior held cron inputs and preserves non-cron held inputs", async () => {
  const idle = scriptedRuntime({ id: "pi", turn: async () => {} });
  await using w = await world({ repos: ["demo"], runtimes: [idle] });
  const lab = { ...starter("lab"), effort: "" };
  await w.agent.save(lab);
  const hired = await w.issue.hire(lab, "patrol", "demo");
  const itemId = issueScopeOf(hired.session)!;
  await waitFor(
    () => w.issue.get(itemId),
    (issue) => issue.status === "in_review",
    "worker finished initial turn and waits for human review",
  );
  await w.intake.subscribe(itemId, ["github:demo#1", "cron:c1"]);
  const githubAccepted = await w.intake.receive({
    source: "github",
    key: "gh-1",
    actor: { kind: "system", id: "github" },
    text: "CI failed",
    threads: ["github:demo#1"],
    addressed: "thread_owner",
    at: 10,
  });
  const olderCronAccepted = await w.intake.receive({
    source: "cron",
    key: "cron-1",
    actor: { kind: "system", id: "c1" },
    text: "tick 1",
    threads: ["cron:c1"],
    addressed: "thread_owner",
    at: 20,
  });
  const newerCronAccepted = await w.intake.receive({
    source: "cron",
    key: "cron-2",
    actor: { kind: "system", id: "c1" },
    text: "tick 2",
    threads: ["cron:c1"],
    addressed: "thread_owner",
    at: 30,
  });
  const held = await inputsOfIssue(w.db.sql, { issue_id: itemId });
  expect(held.map((row) => ({ trigger_id: row.trigger_id, state: row.state, reason: row.reason }))).toEqual([
    { trigger_id: githubAccepted.trigger!.id, state: "held", reason: "human" },
    { trigger_id: newerCronAccepted.trigger!.id, state: "held", reason: "human" },
  ]);
  expect(held.some((row) => row.trigger_id === olderCronAccepted.trigger!.id)).toBe(false);
});
