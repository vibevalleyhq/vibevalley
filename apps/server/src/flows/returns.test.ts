import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { Agent } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Channel } from "@/channel/channel.ts";
import { Ingress, type SourceEvent } from "@/ingress/ingress.ts";
import { Issue } from "@/issue/issue.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import { testIssues } from "@/testing/issues.ts";

import { await_, farm, lab } from "./farm.ts";

const event = (issue: string, key: string): SourceEvent => ({
  source: "connector",
  key,
  actor: { kind: "owner", id: "owner" },
  text: key,
  threads: [`issue:${issue}`],
  addressed: "thread_owner",
  at: 1,
});

it.live("regression: a consumed trigger can be handed back once without losing its source or consumption receipt", () => {
  const f = farm({ runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") }) });
  return Effect.gen(function* () {
    const issues = testIssues(yield* Issue);
    const mailbox = yield* Mailbox;
    const ingress = yield* Ingress;
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* Agent).save(lab());
    const issue = yield* issues.add({ title: "work", project: "handback-trigger", agent: "lab" });
    const started = yield* issues.start(issue.id, "");
    const trigger = (yield* ingress.accept(event(issue.id, "beyond-original-scope")))!;
    const receipt = yield* sql`select routed_at, routing_scope, routing_position from ingress_trigger where id = ${trigger.id}`;
    yield* await_(
      () => sql<{ state: string }>`select state::text from mailbox_delivery where session_id = ${started.session!} and envelope_id = ${trigger.id}`,
      (rows) => rows[0]?.state === "consumed",
      "the original input consumed",
    );
    yield* mailbox.returnInput(started.session!, trigger.id, "another work item");
    yield* mailbox.returnInput(started.session!, trigger.id, "duplicate retry");
    const returned = mailbox.pending(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id);
    expect(returned).toHaveLength(1);
    expect(returned[0]!.envelope_id).not.toBe(trigger.id);
    expect(returned[0]!.payload.note).toContain("another work item");
    expect(returned[0]!.payload.trigger.meta.issue).toBeUndefined();
    expect((yield* ingress.read(trigger.id))?.trigger).toEqual(trigger);
    expect(
      (yield* sql<{ state: string }>`select state::text from mailbox_delivery where session_id = ${started.session!} and envelope_id = ${trigger.id}`)[0]
        ?.state,
    ).toBe("consumed");
    expect((yield* sql<{ state: string }>`select state::text from mailbox_issue where trigger_id = ${trigger.id}`)[0]?.state).toBe("returned");
    expect(yield* sql`select routed_at, routing_scope, routing_position from ingress_trigger where id = ${trigger.id}`).toEqual(receipt);
    yield* mailbox.restore;
    expect(mailbox.pending(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id)).toHaveLength(1);
    const ownerEpoch = yield* sql<{ position: number }>`select max(position)::int as position from mailbox_owner_route where scope = ${returned[0]!.scope}`;
    expect(ownerEpoch[0]!.position).toBe(returned[0]!.position);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: closing an unassigned issue returns its held owner input without a machine chat message", () => {
  const f = farm();
  return Effect.gen(function* () {
    const service = yield* Issue;
    const issues = testIssues(service);
    const mailbox = yield* Mailbox;
    const ingress = yield* Ingress;
    const chat = yield* Channel;
    const sql = yield* SqlClient.SqlClient;
    const issue = yield* issues.add({ title: "waiting", project: "unassigned-return" });
    const source = event(issue.id, "unread-owner-followup");
    const trigger = (yield* ingress.accept(source))!;
    yield* service.setStatus(issue.id, "canceled", "", "", owner);
    yield* await_(
      () => Effect.succeed(mailbox.pending(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id)),
      (rows) => rows.length === 1,
      "held input returned on cancel",
    );
    yield* ingress.accept(source);
    expect(mailbox.pending(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id)).toHaveLength(1);
    expect((yield* sql<{ state: string }>`select state::text from mailbox_issue where trigger_id = ${trigger.id}`)[0]?.state).toBe("returned");
    expect((yield* chat.history(chat.defaultChannel())).some((message) => message.text.includes(source.text))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
