import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { Channel } from "@/channel/chat.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Ingress } from "@/ingress/ingress.ts";
import { Issue, type IssueDispatch } from "@/issue/issue.ts";
import { ingress as ingressLayer } from "@/services.ts";
import { Session } from "@/session/session.ts";
import { testIssues } from "@/testing/issues.ts";
import { waitFor } from "@/testing/until.ts";
import { worldBelowIngress } from "@/testing/world.ts";

it.live("regression: an orchestrator assignment survives ingress startup and an acknowledgement retry without creating chat notices", () => {
  let dispatch: IssueDispatch | undefined;
  const prepared = Layer.effectDiscard(
    Effect.gen(function* () {
      const issues = yield* Issue;
      const item = yield* testIssues(issues).add({ title: "durable assignment", agent: defaultOrchestrator });
      yield* testIssues(issues).start(item.id, (yield* Channel).defaultChannel());
      [dispatch] = yield* issues.pendingDispatches;
    }),
  ).pipe(Layer.provideMerge(worldBelowIngress()));
  return Effect.gen(function* () {
    const source = dispatch!;
    expect(source.text).toBe("durable assignment");
    const ingress = yield* Ingress;
    const issues = yield* Issue;
    const sql = yield* SqlClient.SqlClient;
    const queued = yield* issues.get(source.issue);
    expect(queued.status).toBe("todo");
    expect(queued.lastRun).toBeUndefined();
    yield* ingress.start;
    expect(yield* issues.pendingDispatches).toHaveLength(0);
    const first = yield* sql<{ id: string }>`select id from ingress_trigger where source_key = ${source.id}`;
    expect(first).toHaveLength(1);
    expect((yield* ingress.read(first[0]!.id))?.payload.text).toBe(source.text);
    const deliveries = yield* sql`select session_id, envelope_id from mailbox_delivery where envelope_id = ${first[0]!.id}`;
    expect(deliveries).toHaveLength(1);
    yield* sql`insert into issue_dispatch (id, issue_id, agent, channel, body, trigger_json, created_at)
      values (${source.id}, ${source.issue}, ${source.agent}, ${source.channel}, ${source.text}, ${JSON.stringify(source.by)}, ${source.at})`;
    yield* ingress.refreshIssues;
    expect(yield* issues.pendingDispatches).toHaveLength(0);
    expect(yield* sql`select session_id, envelope_id from mailbox_delivery where envelope_id = ${first[0]!.id}`).toEqual(deliveries);
    expect(yield* sql`select id from channel_message where body = ${source.text}`).toHaveLength(0);
    const release = Promise.withResolvers<void>();
    const { llm } = scriptedLLM([() => release.promise.then(() => answer("finished"))]);
    const config = yield* ServerConfig;
    const host = yield* (yield* Session).host({
      session: { id: defaultOrchestrator, role: "orchestrator", agent: defaultOrchestrator, name: "orchestrator", runtime: "vibevalley", brief: "" },
      inputType: "dispatchTest",
      home: config.home,
      cwd: config.workRoot,
      instructions: "",
      llm: () => llm,
      tools: () => [],
      first: source.channel,
      quiet: () => false,
      say: () => Effect.void,
      channel: (route) => route,
      fresh: () => {},
      restored: () => ({ by: { kind: "issue" } }),
      toolStart: (tool) => ({ text: tool, action: "other", tool }),
    });
    yield* host.submit(
      () => Effect.succeed({ text: source.text }),
      { route: source.channel, run: { issue: source.issue, by: source.by, heard: [first[0]!.id] } },
      true,
    );
    yield* waitFor(issues.get(source.issue), (item) => item.status === "in_progress", "the actual run started").pipe(
      Effect.ensuring(Effect.sync(() => release.resolve())),
    );
    const done = yield* waitFor(issues.get(source.issue), (item) => item.status === "in_review", "the actual run ended");
    expect(done.lastRun?.outcome).toBe("completed");
    const runs = yield* sql<{
      started_at: number;
      ended_at: number;
      outcome: string;
    }>`select started_at, ended_at, outcome from session_run where issue = ${source.issue}`;
    expect(done.lastRun).toEqual({ startedAt: runs[0]!.started_at, endedAt: runs[0]!.ended_at, outcome: runs[0]!.outcome });
  }).pipe(Effect.scoped, Effect.provide(prepared.pipe(ingressLayer)));
});
