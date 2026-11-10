import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabase } from "#/testing/layers.ts";
import { issueInputs, pendingIssueInputs } from "#db/mailbox_issue.sql.ts";

it.effect("regression: reassignment selects unread inputs without loading consumed history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`insert into issue (id, number, description, mandate_strength, max_bot_review_rounds, auto_submit_pr, created_at)
      values ('work', 1, '', 'explicit', 3, false, 0)`;
    yield* sql`insert into session (id, role, agent, name, runtime, brief, hired_at)
      values ('old', 'worker', 'lab', 'lab', 'pi', '', 0)`;
    yield* sql`insert into mailbox_trigger (id, source, source_key, trigger_json, payload_json, occurred_at, routed_at, routing_scope, routing_position)
      select n, 'github', n, '{"actor":{"kind":"user"}}', '{}', 0, 0, 'issue:work', n
      from (with recursive s(n) as (select 1 union all select n + 1 from s where n < 2007) select n from s)`;
    yield* sql`insert into mailbox_issue (trigger_id, issue_id, state, session_id, created_at)
      select n, 'work', 'forwarded', 'old', 0 from (with recursive s(n) as (select 1 union all select n + 1 from s where n < 2007) select n from s)`;
    yield* sql`insert into mailbox_delivery (session_id, envelope_id, scope, source, urgency, reason, wakes, state, payload_json, created_at)
      select 'old', n, 'issue:work', 'github', 'queue', 'addressed', true, 'consumed', '{}', 0
      from (with recursive s(n) as (select 1 union all select n + 1 from s where n < 2006) select n from s)`;
    yield* sql`update mailbox_delivery set state = 'pending' where envelope_id = '2001'`;
    yield* sql`update mailbox_delivery set state = 'handed', launch = 'run' where envelope_id = '2002'`;
    yield* sql`update mailbox_delivery set state = 'dropped', dropped_why = 'left' where envelope_id = '2003'`;
    yield* sql`update mailbox_delivery set state = 'dropped', dropped_why = 'reassigned' where envelope_id = '2004'`;
    yield* sql`update mailbox_delivery set state = 'dropped', dropped_why = 'deleted' where envelope_id = '2005'`;
    yield* sql`update mailbox_issue set state = 'held', session_id = null where trigger_id = '2006'`;
    const selected = (recipient: string | null, closing = false) =>
      Effect.map(pendingIssueInputs({ issue_id: "work", recipient, closing }), (rows) => rows.map((row) => row.trigger_id));
    const selected2 = yield* selected("new");
    expect(selected2).toEqual(["2001", "2002", "2003", "2004", "2006", "2007"]);
    const selected3 = yield* selected("old");
    expect(selected3).toEqual(["2006"]);
    const selected4 = yield* selected(null);
    expect(selected4).toEqual(["2006"]);
    const selected5 = yield* selected(null, true);
    expect(selected5).toEqual(["2001", "2002", "2003", "2004", "2005", "2006", "2007"]);
    const issueInputs2 = yield* issueInputs({ issue_id: "work" });
    expect(issueInputs2).toHaveLength(2007);
  }).pipe(Effect.provide(testDatabase())),
);
