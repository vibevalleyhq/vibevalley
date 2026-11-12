import { Hub, Semaphore, type Subscription, TaskGroup } from "@vibevalley/async";
import { type ChatMessage, type InboxItem } from "@vibevalley/protocol";
import { freshOf } from "@vibevalley/protocol/rules";

import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { toMessage } from "#/modules/channel/contracts.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import type { Session } from "#/modules/session/session.ts";
import { messageByID, notificationReceipt, userReadReports } from "#db/channel_message.sql.ts";

import { forUser, inbox, inboxEntries } from "./items.ts";
import { emptyPatrol, type PatrolMemory, type PatrolNote, patrolStep } from "./patrol.ts";
import { patrolText } from "./prompts.ts";

export interface Inbox {
  /** What came into the inbox, each item once; what stood when the farm came up is known, not news. */
  readonly news: () => Subscription<readonly InboxItem[]>;
  /** The farm's talk the user hears off the farm, as it is said (forUser); the chat apps carry it. */
  readonly toUser: () => Subscription<ChatMessage>;
  /** One round of the patrol, now. */
  readonly patrol: () => Promise<void>;
  readonly handoffState: (message: string) => Promise<"unseen" | "seen" | undefined>;
  readonly prime: () => Promise<void>;
  /** Pending external deliveries changed: a later connector rereads them. */
  readonly externalChanges: () => Subscription<void>;
  /** After the sessions and issues came back: the inbox as it stands is known, and the patrol starts its rounds. */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface InboxDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly channel: Channel;
  readonly issue: Issue;
  readonly session: Session;
}

export async function makeInbox(deps: InboxDeps): Promise<Inbox> {
  const { core, channel: chat, issue: issues, session: sessions, db, clock, config } = deps;
  const log = deps.log.child("inbox");
  const tasks = new TaskGroup({ name: "inbox", onError: (task, e) => log.error(`${task} failed:`, e) });
  const turn = new Semaphore(1);
  const externalHub = new Hub<void>();

  const handoffState = async (id: string) => {
    const row = await messageByID(db.sql, { id });
    if (!row || row.deleted_at !== null) return undefined;
    const message = toMessage(row);
    if (!forUser(message, chat.notifyOf(message.channel))) return undefined;
    const receipt = await notificationReceipt(db.sql, { id });
    if (!receipt || receipt.superseded) return undefined;
    if (message.kind === "report") {
      const session = sessions.live(message.from).session;
      const issue = issues.onBoard().find((item) => item.id === session?.issue);
      if (issue && !["draft", "asking", "stuck", "reviewing"].includes(issue.stage.state)) return undefined;
      if (!issue && session?.phase._tag === "working") return undefined;
    }
    return receipt.read_at === null ? ("unseen" as const) : ("seen" as const);
  };

  let known: Set<string> | undefined;
  let primed = false;
  const newsHub = new Hub<readonly InboxItem[]>();
  const toUserHub = new Hub<ChatMessage>();
  const facts = core.subscribe();
  tasks.run("user notifications", async (signal) => {
    try {
      for (let r = await facts.next(signal); r.done !== true; r = await facts.next(signal)) {
        const event = r.value;
        await turn.with(() =>
          bestEffort(log, "vibevalley: user notifications failed", async () => {
            if (event.type === "messageChanged" && (await handoffState(event.message.id)) === "unseen") toUserHub.publish(event.message);
            if (event.type === "messageChanged" || event.type === "sessionReported" || event.type === "issueChanged") externalHub.publish(undefined);
            if (!primed) return;
            const news = freshOf(known, inbox(core.state()));
            known = news.known;
            if (news.fresh.length > 0) newsHub.publish(news.fresh);
          }),
        );
      }
    } finally {
      facts.close();
    }
  });
  const userReads = chat.userReads();
  tasks.run("user reads", async (signal) => {
    try {
      for (let r = await userReads.next(signal); r.done !== true; r = await userReads.next(signal)) externalHub.publish(undefined);
    } finally {
      userReads.close();
    }
  });

  let memory: PatrolMemory = emptyPatrol();
  const patrol = async () => {
    const state = core.state();
    const now = clock.now();
    const read = await userReadReports(db.sql);
    const userSeen = Object.fromEntries(
      inboxEntries(state).flatMap((entry) => {
        const target = entry.item.target;
        if (target.kind !== "session") return [];
        const receipt = read.find((row) => row.sender_id === target.id && row.created_at >= entry.item.at);
        return receipt ? [[entry.item.id, receipt.updated_at]] : [];
      }),
    );
    const [report, next] = patrolStep(state, now, memory, userSeen);
    memory = next;
    const byChannel = new Map<string, PatrolNote[]>();
    for (const f of report) {
      const c = f.channel ?? chat.defaultChannel();
      byChannel.set(c, [...(byChannel.get(c) ?? []), f]);
    }
    await bestEffort(log, "vibevalley: patrol inputs were not kept", async () => {
      for (const [channel, notes] of byChannel) {
        const top = await chat.topOf(channel);
        const trigger = await sessions.recordTrigger({
          key: `${channel}:${now}:${notes.map((note) => note.key).join(",")}`,
          source: "patrol",
          actor: { kind: "system", id: "patrol" },
          addressed: "direct",
          threads: [],
          replyChannel: channel,
          at: now,
          text: patrolText(top.name, notes),
        });
        await sessions.route(trigger);
      }
    });
  };

  const prime = () =>
    turn.with(async () => {
      const state = core.state();
      known = freshOf(undefined, inbox(state)).known;
      primed = true;
    });

  return {
    news: () => newsHub.subscribe(),
    toUser: () => toUserHub.subscribe(),
    patrol,
    handoffState,
    prime,
    externalChanges: () => externalHub.subscribe(),
    boot: async () => {
      await prime();
      const every = config.patrol.heartbeatMinutes * 60_000;
      if (every > 0)
        tasks.run("patrol", async (signal) => {
          while (true) {
            await clock.sleep(every, signal);
            await patrol();
          }
        });
    },
    close: async () => {
      await tasks.close();
      for (const hub of [newsHub, toUserHub, externalHub]) hub.end();
    },
  };
}
