import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Channel } from "@/channel/channel.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Ingress } from "@/ingress/ingress.ts";
import { Issue } from "@/issue/issue.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import { ingress as ingressLayer } from "@/services.ts";
import { Session } from "@/session/session.ts";
import { testIssues } from "@/testing/issues.ts";
import { waitFor } from "@/testing/until.ts";
import { worldBelowIngress } from "@/testing/world.ts";

it.live("regression: an orchestrator assignment survives ingress startup and an acknowledgement retry without creating chat notices", () => {
  let triggerId = "";
  let issueId = "";
  const prepared = Layer.effectDiscard(
    Effect.gen(function* () {
      const issues = yield* Issue;
      const item = yield* testIssues(issues).add({ title: "durable assignment", agent: defaultOrchestrator });
      yield* testIssues(issues).start(item.id, (yield* Channel).defaultChannel());
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ id: string }>`select id from ingress_trigger
        where trigger_json::jsonb->'meta'->>'issue' = ${item.id} and trigger_json::jsonb->'meta'->>'dispatch' = 'true'
        order by seq desc limit 1`;
      triggerId = rows[0]?.id ?? "";
      issueId = item.id;
    }),
  ).pipe(Layer.provideMerge(worldBelowIngress()));
  return Effect.gen(function* () {
    const ingress = yield* Ingress;
    const issues = yield* Issue;
    const mailbox = yield* Mailbox;
    const sql = yield* SqlClient.SqlClient;
    const source = (yield* ingress.read(triggerId))!;
    expect(source.payload.text).toBe("durable assignment");
    const queued = yield* issues.get(issueId);
    expect(queued.status).toBe("todo");
    expect(queued.lastRun).toBeUndefined();
    // A crash between the trigger's write and its hand-off: the row is there, routed to no one.
    yield* sql`delete from mailbox_delivery where envelope_id = ${triggerId}`;
    yield* sql`delete from mailbox_issue where trigger_id = ${triggerId}`;
    yield* sql`update ingress_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${triggerId}`;
    yield* mailbox.start;
    yield* (yield* Mailbox).replay;
    const deliveries = yield* sql`select session_id, envelope_id from mailbox_delivery where envelope_id = ${triggerId}`;
    expect(deliveries).toHaveLength(1);
    // A second replay of the same unrouted row acknowledges no second delivery.
    yield* sql`update ingress_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${triggerId}`;
    yield* (yield* Issue).refreshQueue;
    expect(yield* sql`select session_id, envelope_id from mailbox_delivery where envelope_id = ${triggerId}`).toEqual(deliveries);
    expect(yield* sql`select id from channel_message where body = ${source.payload.text}`).toHaveLength(0);
    const release = Promise.withResolvers<void>();
    const { llm } = scriptedLLM([() => release.promise.then(() => answer("finished"))]);
    const config = yield* ServerConfig;
    const channel = source.trigger.replyChannel ?? (yield* Channel).defaultChannel();
    const by = yield* Schema.decodeEffect(Schema.fromJsonString(S.RunTrigger))(JSON.stringify(source.trigger.meta.trigger)).pipe(Effect.orDie);
    const host = yield* (yield* Session).host({
      session: { id: defaultOrchestrator, role: "orchestrator", agent: defaultOrchestrator, name: "orchestrator", runtime: "vibevalley", brief: "" },
      inputType: "dispatchTest",
      home: config.home,
      cwd: config.workRoot,
      instructions: "",
      llm: () => llm,
      tools: () => [],
      first: channel,
      quiet: () => false,
      say: () => Effect.void,
      channel: (route) => route,
      fresh: () => {},
      restored: () => ({ by: { kind: "issue" } }),
      toolStart: (tool) => ({ text: tool, action: "other", tool }),
    });
    yield* host.submit(() => Effect.succeed({ text: source.payload.text }), { route: channel, run: { issue: issueId, by, heard: [triggerId] } }, true);
    yield* waitFor(issues.get(issueId), (item) => item.status === "in_progress", "the actual run started").pipe(
      Effect.ensuring(Effect.sync(() => release.resolve())),
    );
    const done = yield* waitFor(issues.get(issueId), (item) => item.status === "in_review", "the actual run ended");
    expect(done.lastRun?.outcome).toBe("completed");
    const runs = yield* sql<{
      started_at: number;
      ended_at: number;
      outcome: string;
    }>`select started_at, ended_at, outcome from session_run where issue = ${issueId}`;
    expect(done.lastRun).toEqual({ startedAt: runs[0]!.started_at, endedAt: runs[0]!.ended_at, outcome: runs[0]!.outcome });
  }).pipe(Effect.scoped, Effect.provide(prepared.pipe(ingressLayer)));
});
