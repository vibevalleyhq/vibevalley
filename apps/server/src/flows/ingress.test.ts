import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { Channel } from "#/channel/channel.ts";
import { Ingress } from "#/ingress/ingress.ts";
import { explicitMandate } from "#/issue/creation.ts";
import { Issue } from "#/issue/issue.ts";
import { Mailbox, type InsertDelivery } from "#/mailbox/mailbox.ts";
import { Resource } from "#/resource/resource.ts";
import { Session } from "#/session/session.ts";
import { committedDelivery } from "#/testing/deliveries.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab, until } from "./farm.ts";

it.live("regression: the mandate grants its worker access to the original trigger without granting another issue access", () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("done");
      },
    }),
  });
  return Effect.gen(function* () {
    const ingress = yield* Ingress;
    const issues = yield* Issue;
    const resource = yield* Resource;
    yield* (yield* Agent).save(lab());
    const source = (yield* ingress.record({
      source: "workbench",
      key: "mandate-source",
      actor: { kind: "user", id: "user" },
      addressed: "direct",
      threads: [],
      text: "original requirement",
      at: 1,
    }))!;
    const item = yield* issues.add({ title: "authorized work", repo: "mandate", agent: "lab" }, explicitMandate(source.id));
    const started = yield* testIssues(issues).start(item.id, "");
    yield* until(() => inputs.some((input) => input.includes(source.card.readUri)), "the worker given the original source");
    expect((yield* resource.read(started.session!, { uri: source.card.readUri })).text).toContain("original requirement");
    const other = yield* issues.add({ title: "unrelated work", repo: "unrelated", agent: "lab" }, explicitMandate());
    const second = yield* testIssues(issues).start(other.id, "");
    const resourceFailure = yield* Effect.flip(resource.read(second.session!, { uri: source.card.readUri }));
    expect(resourceFailure).toMatchObject({ _tag: "ResourceError" });
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: chat triggers keep their original payload through edits and replay and expose neighboring messages", () => {
  const f = farm();
  return Effect.gen(function* () {
    const chat = yield* Channel;
    const ingress = yield* Ingress;
    const mailbox = yield* Mailbox;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* chat.post({ _tag: "User", text: "previous message", sendKey: "before" });
    const current = yield* ingress.user({ source: "voice", text: "original voice input", envelope: "voice-source" });
    yield* chat.post({ _tag: "User", text: "next message", sendKey: "after" });
    yield* chat.edit(current.message.id, "edited voice input");
    yield* sql`update mailbox_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${current.message.id}`;
    yield* (yield* Mailbox).replay;
    const registered2 = yield* mailbox.isRouted(current.message.id);
    expect(registered2).toBe(false);
    yield* chat.start;
    yield* mailbox.start;
    const registered3 = yield* mailbox.isRouted(current.message.id);
    expect(registered3).toBe(true);
    const source = yield* ingress.read(current.message.id);
    expect(source?.trigger.source).toBe("voice");
    expect(source?.payload.text).toBe("original voice input");
    expect(source?.trigger.card.readUri).toBe(`vv://trigger/${current.message.id}`);
    const resource = yield* (yield* Resource).read(defaultOrchestrator, { uri: source!.trigger.card.readUri });
    expect(resource.text).toContain("original voice input");
    expect(resource.text).toContain(before.message.id);
    expect(resource.text).toContain("next message");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: a persisted machine trigger reaches a worker without a chat message", () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("done");
      },
    }),
  });
  return Effect.gen(function* () {
    const issue2 = yield* Issue;
    const issues = testIssues(issue2);
    const sessions = yield* Session;
    const mailbox = yield* Mailbox;
    const chat = yield* Channel;
    yield* (yield* Agent).save(lab());
    const issue = yield* issues.add({ title: "work", repo: "machine-trigger", agent: "lab" });
    const started = yield* issues.start(issue.id, "");
    const session = started.session!;
    yield* until(() => sessions.sessionOf(session)?.phase._tag === "done", "the worker waiting");
    const thread = (yield* await_(
      () => chat.threadOfSession(session),
      (id) => id !== undefined,
      "the worker thread",
    ))!;
    const trigger = (yield* (yield* Ingress).record({
      source: "github",
      key: "ci:1",
      actor: { kind: "ci", id: "checks" },
      addressed: "thread_owner",
      text: "machine-only-detail ".repeat(100),
      threads: [`issue:${issue.id}`],
      replyChannel: thread,
      at: 1,
    }))!;
    const delivery: InsertDelivery = {
      session,
      row: {
        envelope_id: trigger.id,
        scope: `issue:${issue.id}`,
        message_id: null,
        channel_id: thread,
        source: trigger.source,
        urgency: "queue",
        reason: "addressed",
        wakes: true,
        held_by: null,
        state: "pending",
        launch: null,
        created_at: trigger.at,
        payload: { trigger, context: { number: 0, target: trigger.card.readUri }, channelType: "thread" },
      },
    };
    yield* committedDelivery(delivery);
    yield* mailbox.restore;
    expect(mailbox.deliveriesOf(session).find((row) => row.envelope_id === trigger.id)?.message_id).toBeNull();
    yield* mailbox.start;
    expect(inputs.some((input) => input.includes(trigger.card.readUri))).toBe(false);
    yield* (yield* Ingress).accept({
      source: "connector",
      key: "resume-machine-work",
      actor: { kind: "user", id: "user" },
      addressed: "thread_owner",
      threads: [`issue:${issue.id}`],
      replyChannel: thread,
      text: "handle the queued input",
      at: 2,
    });
    yield* until(() => inputs.some((input) => input.includes(trigger.card.readUri)), "the machine card delivered");
    yield* until(() => mailbox.deliveriesOf(session).every((row) => row.envelope_id !== trigger.id), "the actual input consumed");
    yield* committedDelivery(delivery);
    expect(mailbox.deliveriesOf(session).some((row) => row.envelope_id === trigger.id)).toBe(false);
    const messages = yield* await_(
      () => chat.history(thread),
      (items) => items.some((message) => message.kind === "report"),
      "the worker report",
    );
    expect(messages.some((message) => message.text.includes("machine-only-detail"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: issue input waits without a session and a user followup releases frozen machine input", () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("done");
      },
    }),
  });
  return Effect.gen(function* () {
    const issue2 = yield* Issue;
    const issues = testIssues(issue2);
    const sessions = yield* Session;
    const mailbox = yield* Mailbox;
    const ingress = yield* Ingress;
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* Agent).save(lab());
    const issue = yield* issues.add({ title: "subscription work", repo: "source-routing", agent: "lab" });
    yield* mailbox.subscribe(issue.id, ["github:source-routing#7"]);
    const userEvent = {
      source: "connector" as const,
      key: "queued-user",
      actor: { kind: "user" as const, id: "user" },
      text: "queued-user-detail",
      threads: ["github:source-routing#7"],
      addressed: "thread_owner" as const,
      at: 1,
    };
    const queued = (yield* ingress.accept(userEvent))!;
    expect(sessions.hired()).toHaveLength(0);
    expect((yield* sql<{ state: string }>`select state from mailbox_issue where trigger_id = ${queued.id}`)[0]?.state).toBe("held");
    const started = yield* issues.start(issue.id, "");
    yield* until(() => inputs.some((input) => input.includes("queued-user-detail")), "the queued input delivered");
    expect(inputs[0]).toContain("queued-user-detail");
    yield* until(() => sessions.sessionOf(started.session!)?.phase._tag === "done", "the worker handed back");
    const automatic = (yield* ingress.accept({
      source: "github",
      key: "ci-failure",
      actor: { kind: "ci", id: "checks" },
      text: "frozen-ci-detail",
      threads: ["github:source-routing#7"],
      addressed: "thread_owner",
      at: 2,
    }))!;
    expect((yield* sql<{ state: string; reason: string }>`select state, reason from mailbox_issue where trigger_id = ${automatic.id}`)[0]).toEqual({
      state: "held",
      reason: "human",
    });
    expect(inputs.some((input) => input.includes("frozen-ci-detail"))).toBe(false);
    yield* ingress.accept(userEvent);
    expect((yield* sql<{ state: string }>`select state from mailbox_issue where trigger_id = ${automatic.id}`)[0]?.state).toBe("held");
    yield* ingress.accept({ ...userEvent, key: "release-user", text: "release-user-detail", at: 3 });
    yield* until(() => inputs.some((input) => input.includes("frozen-ci-detail")), "the frozen input released");
    expect((yield* issues.list()).map((item) => item.id)).toEqual([issue.id]);
    expect((yield* sql<{ session_id: string }>`select session_id from mailbox_issue where trigger_id = ${automatic.id}`)[0]?.session_id).toBe(started.session);
    expect((yield* (yield* Resource).read(started.session!, { uri: automatic.card.readUri })).text).toContain("frozen-ci-detail");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
