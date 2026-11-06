import { Clock, Context, Effect, Layer, PubSub, Schedule, type Scope, Semaphore, Stream } from "effect";

import { type ChatMessage, type InboxItem } from "@vibevalley/protocol";
import { freshOf } from "@vibevalley/protocol/rules";

import { scopedPubSub } from "#/base/pubsub.ts";
import { Channel } from "#/channel/channel.ts";
import { toMessage } from "#/channel/contracts.ts";
import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Issue } from "#/issue/issue.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Session } from "#/session/session.ts";
import { messageByID, notificationReceipt, ownerReadReports } from "#db/channel_message.sql.ts";

import { forOwner, inbox, inboxEntries } from "./items.ts";
import { emptyPatrol, type PatrolMemory, type PatrolNote, patrolStep } from "./patrol.ts";
import { patrolText } from "./prompts.ts";

export class Inbox extends Context.Service<
  Inbox,
  {
    /** What came into the inbox, each item once; what stood when the farm came up is known, not news. */
    readonly news: Effect.Effect<Stream.Stream<readonly InboxItem[]>, never, Scope.Scope>;
    /** The farm's talk the owner hears off the farm, as it is said (forOwner); the chat apps carry it. */
    readonly toOwner: Effect.Effect<Stream.Stream<ChatMessage>, never, Scope.Scope>;
    /** One round of the patrol, now. */
    readonly patrol: Effect.Effect<void>;
    readonly handoffState: (message: string) => Effect.Effect<"unseen" | "seen" | undefined>;
    readonly prime: Effect.Effect<void>;
    /** Pending external deliveries changed: a later connector rereads them. */
    readonly externalChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("vibevalley/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const core = yield* Core;
  const chat = yield* Channel;
  const issues = yield* Issue;
  const sessions = yield* Session;
  const mailbox = yield* Mailbox;
  const db = yield* Db;
  const turn = yield* Semaphore.make(1);
  const externalHub = yield* scopedPubSub<void>();

  const handoffState = Effect.fn("Inbox.handoffState")(function* (id: string) {
    const row = yield* db.one(messageByID({ id }));
    if (!row || row.deleted_at !== null) return undefined;
    const message = toMessage(row);
    if (!forOwner(message, chat.notifyOf(message.channel))) return undefined;
    const receipt = yield* db.one(notificationReceipt({ id }));
    if (!receipt || receipt.superseded) return undefined;
    if (message.kind === "report") {
      const session = sessions.sessionOf(message.from);
      const issue = issues.onBoard().find((item) => item.id === session?.issue);
      if (issue && !["draft", "asking", "stuck", "reviewing"].includes(issue.stage.state)) return undefined;
      if (!issue && session?.phase._tag === "working") return undefined;
    }
    return receipt.read_at === null ? ("unseen" as const) : ("seen" as const);
  });

  let known: Set<string> | undefined;
  let primed = false;
  const newsHub = yield* scopedPubSub<readonly InboxItem[]>();
  const toOwnerHub = yield* scopedPubSub<ChatMessage>();
  const facts = yield* core.subscribe;
  yield* Effect.forkScoped(
    Stream.runForEach(facts, (event) =>
      turn.withPermits(1)(
        Effect.gen(function* () {
          if (event.type === "messageChanged" && (yield* handoffState(event.message.id)) === "unseen") yield* PubSub.publish(toOwnerHub, event.message);
          if (event.type === "messageChanged" || event.type === "sessionReported" || event.type === "issueChanged")
            yield* PubSub.publish(externalHub, undefined);
          if (!primed) return;
          const news = freshOf(known, inbox(core.state()));
          known = news.known;
          if (news.fresh.length > 0) yield* PubSub.publish(newsHub, news.fresh);
        }).pipe(bestEffort("vibevalley: owner notifications failed")),
      ),
    ),
  );
  yield* Effect.forkScoped(Stream.runForEach(yield* chat.ownerReads, () => PubSub.publish(externalHub, undefined)));

  let memory: PatrolMemory = emptyPatrol();
  const patrol = Effect.gen(function* () {
    const state = core.state();
    const now = yield* Clock.currentTimeMillis;
    const read = yield* db.run(ownerReadReports());
    const ownerSeen = Object.fromEntries(
      inboxEntries(state).flatMap((entry) => {
        const target = entry.item.target;
        if (target.kind !== "session") return [];
        const receipt = read.find((row) => row.sender_id === target.id && row.created_at >= entry.item.at);
        return receipt ? [[entry.item.id, receipt.updated_at]] : [];
      }),
    );
    const [report, next] = patrolStep(state, now, memory, ownerSeen);
    memory = next;
    const byChannel = new Map<string, PatrolNote[]>();
    for (const f of report) {
      const c = f.channel ?? chat.defaultChannel();
      byChannel.set(c, [...(byChannel.get(c) ?? []), f]);
    }
    yield* Effect.forEach(
      byChannel,
      ([channel, notes]) =>
        Effect.flatMap(chat.topOf(channel), (top) =>
          mailbox
            .recordTrigger({
              key: `${channel}:${now}:${notes.map((note) => note.key).join(",")}`,
              source: "patrol",
              actor: { kind: "system", id: "patrol" },
              addressed: "direct",
              threads: [],
              replyChannel: channel,
              at: now,
              text: patrolText(top.name, notes),
            })
            .pipe(Effect.flatMap(mailbox.receive)),
        ),
      { discard: true },
    ).pipe(bestEffort("vibevalley: patrol inputs were not kept"));
  });

  const prime = turn.withPermits(1)(
    Effect.sync(() => {
      const state = core.state();
      known = freshOf(undefined, inbox(state)).known;
      primed = true;
    }),
  );

  return Inbox.of({
    news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    toOwner: Effect.map(PubSub.subscribe(toOwnerHub), Stream.fromSubscription),
    patrol,
    handoffState,
    prime,
    externalChanges: Effect.map(PubSub.subscribe(externalHub), Stream.fromSubscription),
  });
});

/** After the sessions and issues came back: the inbox as it stands is known, and the patrol starts its rounds. */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const service = yield* Inbox;
    yield* service.prime;
    const every = config.patrol.heartbeatMinutes * 60_000;
    if (every > 0) yield* Effect.forkScoped(service.patrol.pipe(Effect.repeat(Schedule.spaced(every)), Effect.delay(every)));
  }),
);
