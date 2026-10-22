// Notifications: what in the inbox is news to the owner, and the patrol (what has waited past its kind's grace). The
// routes listen and say it their own way: on a call the assistant says the news (voice), the patrol's findings wake the
// assistant, and the page rings, notifies and fills the tray from the same inbox in the frame, each item worded there.

import type { InboxItem } from "@vibevalley/protocol";
import { freshOf } from "@vibevalley/protocol/rules";
import { inbox } from "./inbox.ts";
import { Context, Effect, Layer, PubSub, type Scope, Stream } from "effect";
import { Settings } from "../base/config.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { emptyPatrol, type PatrolMemory, type PatrolNote, patrolStep } from "./rules.ts";

/** What has waited too long in one channel. */
export interface Overdue {
  readonly channel: string;
  readonly notes: readonly PatrolNote[];
}

export interface NoticeShape {
  /** What came into the inbox, each item once; what stood when the farm came up is known, not news. */
  readonly news: Effect.Effect<Stream.Stream<readonly InboxItem[]>, never, Scope.Scope>;
  /** The patrol's findings, one per channel. */
  readonly overdue: Effect.Effect<Stream.Stream<Overdue>, never, Scope.Scope>;
  /** One round of the patrol, now. */
  readonly patrol: Effect.Effect<void>;
  /** From here what the inbox holds is known: the startup's, after the sessions and issues came back. */
  readonly prime: Effect.Effect<void>;
}

export class Notices extends Context.Service<Notices, NoticeShape>()("vibevalley/Notices") {}

export interface NoticeOptions {
  /** The patrol's clock. */
  readonly now?: () => number;
}

export const make = (options: NoticeOptions = {}) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const chat = yield* Channels;

    // Until the startup primes it nothing is news: what comes back with the sessions was there before the stop.
    let known: Set<string> | undefined;
    let primed = false;
    const newsHub = yield* PubSub.unbounded<readonly InboxItem[]>();
    const facts = yield* core.subscribe;
    yield* Effect.forkScoped(
      Stream.runForEach(facts, () =>
        Effect.gen(function* () {
          if (!primed) return;
          const news = freshOf(known, inbox(core.state()));
          known = news.known;
          if (news.fresh.length > 0) yield* PubSub.publish(newsHub, news.fresh);
        }),
      ),
    );

    const overdueHub = yield* PubSub.unbounded<Overdue>();
    let memory: PatrolMemory = emptyPatrol();
    const patrol = Effect.gen(function* () {
      const [report, next] = patrolStep(core.state(), (options.now ?? Date.now)(), memory);
      memory = next;
      const byChannel = new Map<string, PatrolNote[]>();
      for (const f of report) {
        const c = f.channel ?? chat.general();
        byChannel.set(c, [...(byChannel.get(c) ?? []), f]);
      }
      for (const [channel, notes] of byChannel) yield* PubSub.publish(overdueHub, { channel, notes });
    });

    const shape: NoticeShape = {
      news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
      overdue: Effect.map(PubSub.subscribe(overdueHub), Stream.fromSubscription),
      patrol,
      prime: Effect.sync(() => {
        known = freshOf(undefined, inbox(core.state())).known;
        primed = true;
      }),
    };
    return shape;
  });

export const layer = (options?: NoticeOptions) => Layer.effect(Notices, make(options));

/** After the sessions and issues came back: the inbox as it stands is known, and the patrol starts its rounds. The first
 * round waits one interval: right after a start, what looks hanging is mostly the restart. */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Settings;
    const notices = yield* Notices;
    yield* notices.prime;
    const every = config.patrol.heartbeatMinutes * 60_000;
    if (every > 0) yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(every), notices.patrol)));
  }),
);
