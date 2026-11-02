// The inbox: what in it is news to the owner, and the patrol (what has waited past its kind's grace). The
// routes listen and say it their own way: on a call the orchestrator says the news (voice), the patrol's findings wake the
// orchestrator, and the page rings, notifies and fills the tray from the same inbox in the frame, each item worded there.

import { Clock, Context, Effect, Layer, PubSub, Schedule, type Scope, Semaphore, Stream } from "effect";

import { type ChatMessage, type InboxItem } from "@vibevalley/protocol";
import { freshOf } from "@vibevalley/protocol/rules";

import { scopedPubSub } from "@/base/pubsub.ts";
import { Channel } from "@/channel/chat.ts";
import { toMessage } from "@/channel/contracts.ts";
import { Core } from "@/core/core.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Ingress } from "@/ingress/ingress.ts";
import { Issue } from "@/issue/issue.ts";
import { Session } from "@/session/session.ts";

import * as q from "../../db/generated/channel_message.sql.ts";
import { forOwner } from "./away.ts";
import { inbox, inboxEntries } from "./items.ts";
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
    /** A later connector registers one invalidation callback for pending external deliveries. */
    readonly attachExternalChange: (notify: () => void) => void;
    /** From here what the inbox holds is known: the startup's, after the sessions and issues came back. */
    readonly prime: Effect.Effect<void>;
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
  const ingress = yield* Ingress;
  const db = yield* Db;
  const turn = yield* Semaphore.make(1);
  let externalChanged: () => void = () => {};

  const handoffState = Effect.fn("Inbox.handoffState")(function* (id: string) {
    const row = yield* db.one(q.messageByID({ id }));
    if (!row || row.deleted_at !== null) return undefined;
    const message = toMessage(row);
    if (!forOwner(message, chat.notifyOf(message.channel))) return undefined;
    const receipt = yield* db.one(q.notificationReceipt({ id }));
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
          if (event.type === "message" && (yield* handoffState(event.message.id)) === "unseen") yield* PubSub.publish(toOwnerHub, event.message);
          if (event.type === "message" || event.type === "sessionReport" || event.type === "issue") externalChanged();
          if (!primed) return;
          const news = freshOf(known, inbox(core.state()));
          known = news.known;
          if (news.fresh.length > 0) yield* PubSub.publish(newsHub, news.fresh);
        }).pipe(bestEffort("vibevalley: owner notifications failed")),
      ),
    ),
  );
  yield* Effect.forkScoped(Stream.runForEach(yield* chat.ownerReads, () => Effect.sync(externalChanged)));

  let memory: PatrolMemory = emptyPatrol();
  const patrol = Effect.gen(function* () {
    const state = core.state();
    const now = yield* Clock.currentTimeMillis;
    const read = yield* db.run(q.ownerReadReports());
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
          ingress.accept({
            key: `${channel}:${now}:${notes.map((note) => note.key).join(",")}`,
            source: "patrol",
            actor: { kind: "system", id: "patrol" },
            addressed: "direct",
            threads: [],
            replyChannel: channel,
            at: now,
            text: patrolText(top.name, notes),
          }),
        ),
      { discard: true },
    ).pipe(bestEffort("vibevalley: patrol inputs were not kept"));
  });

  const shape = Inbox.of({
    news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    toOwner: Effect.map(PubSub.subscribe(toOwnerHub), Stream.fromSubscription),
    patrol,
    handoffState,
    attachExternalChange: (notify) => {
      externalChanged = notify;
    },
    prime: turn.withPermits(1)(
      Effect.sync(() => {
        const state = core.state();
        known = freshOf(undefined, inbox(state)).known;
        primed = true;
      }),
    ),
  });
  return shape;
});

/** After the sessions and issues came back: the inbox as it stands is known, and the patrol starts its rounds. The first
 * round waits one interval: right after a start, what looks hanging is mostly the restart. */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const service = yield* Inbox;
    yield* service.prime;
    const every = config.patrol.heartbeatMinutes * 60_000;
    if (every > 0) yield* Effect.forkScoped(service.patrol.pipe(Effect.repeat(Schedule.spaced(every)), Effect.delay(every)));
  }),
);
