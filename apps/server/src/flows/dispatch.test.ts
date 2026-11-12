import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { waitFor } from "#/testing/layers.ts";
import { answer, scriptedLLM } from "#/testing/model.ts";
import { sqlOf } from "#/testing/sql.ts";
import { moduleWorld, testIssues } from "#/testing/world.ts";

test("regression: an orchestrator assignment survives startup and an acknowledgement retry without creating chat notices", async () => {
  let triggerId = "";
  let issueId = "";
  await using fw = await moduleWorld();
  {
    const issues = fw.issue;
    const item = await testIssues(issues).add({ title: "durable assignment", agent: defaultOrchestrator });
    await testIssues(issues).start(item.id, fw.channel.defaultChannel());
    const sql = sqlOf(fw.db);
    const rows = await sql<{ id: string }>`select id from session_trigger
        where trigger_json::jsonb->'meta'->>'issue' = ${item.id} and trigger_json::jsonb->'meta'->'dispatch' = 'true'
        order by seq desc limit 1`;
    triggerId = rows[0]?.id ?? "";
    issueId = item.id;
  }
  const issues = fw.issue;
  const mailbox = fw.session;
  const sql = sqlOf(fw.db);
  const source = (await mailbox.readTrigger(triggerId))!;
  expect(source.payload.text).toBe("durable assignment");
  const queued = await issues.get(issueId);
  expect(queued.status).toBe("todo");
  expect(queued.lastRun).toBeUndefined();
  // A crash between the trigger's write and its hand-off: the row is there, routed to no one.
  await sql`delete from session_delivery where envelope_id = ${triggerId}`;
  await sql`delete from session_issue_input where trigger_id = ${triggerId}`;
  await sql`update session_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${triggerId}`;
  await mailbox.wake();
  await fw.session.replay();
  const deliveries = await sql`select session_id, envelope_id from session_delivery where envelope_id = ${triggerId}`;
  expect(deliveries).toHaveLength(1);
  // A second replay of the same unrouted row acknowledges no second delivery.
  await sql`update session_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${triggerId}`;
  await fw.issue.refreshQueue();
  const rows = await sql`select session_id, envelope_id from session_delivery where envelope_id = ${triggerId}`;
  expect(rows).toEqual(deliveries);
  const rows2 = await sql`select id from channel_message where body = ${source.payload.text}`;
  expect(rows2).toHaveLength(0);
  const release = Promise.withResolvers<void>();
  fw.deepseek.use(scriptedLLM([() => release.promise.then(() => answer("finished"))]).llm);
  const config = fw.config;
  const channel = source.trigger.replyChannel ?? fw.channel.defaultChannel();
  const by = S.RunTrigger.parse(JSON.parse(JSON.stringify(source.trigger.meta.trigger)));
  await using host = await fw.session.host({
    session: { id: defaultOrchestrator, role: "orchestrator", agent: defaultOrchestrator, name: "orchestrator", runtime: "vibevalley", brief: "" },
    inputType: "dispatchTest",
    home: config.home,
    cwd: config.workRoot,
    instructions: "",
    model: () => "",
    tools: () => [],
    first: channel,
    quiet: () => false,
    say: () => Promise.resolve(),
    channel: (route) => route,
    fresh: () => {},
    restored: () => ({ by: { kind: "issue" } }),
    toolStart: (tool) => ({ text: tool, action: "other", tool }),
  });
  await host.submit(() => Promise.resolve({ text: source.payload.text }), { route: channel, run: { issue: issueId, by, heard: [triggerId] } }, true);
  try {
    await waitFor(
      () => issues.get(issueId),
      (item) => item.status === "in_progress",
      "the actual run started",
    );
  } finally {
    release.resolve();
  }
  const done = await waitFor(
    () => issues.get(issueId),
    (item) => item.status === "in_review",
    "the actual run ended",
  );
  expect(done.lastRun?.outcome).toBe("completed");
  const runs = await sql<{
    started_at: number;
    ended_at: number;
    outcome: string;
  }>`select started_at, ended_at, outcome from session_run where issue = ${issueId}`;
  expect(done.lastRun).toEqual({ startedAt: runs[0]!.started_at, endedAt: runs[0]!.ended_at, outcome: runs[0]!.outcome });
});
