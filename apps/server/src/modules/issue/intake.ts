// An issue's intake: the triggers that reach the farm, routed. What is in an issue's threads goes into its pool
// (issue_input), held while the issue cannot take it and forwarded to its session once it can; what is not goes to the
// sessions the watch heard it for, or to the orchestrator it names or the one of its place. The sessions only deliver
// (Session.route): which session hears what is decided here and above.
//
// Routing is one at a time (the lock), and a route, once begun, runs to its end. A trigger recorded and not routed (a
// restart between the two) is routed again from Session.unrouted; a route is kept with the trigger's id, so one already
// in a pool is not taken twice.
import { Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonOf } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Accepted, Delivery, Hearer } from "#/modules/session/envelope.ts";
import { deliveryScope, type SourceEvent } from "#/modules/session/payload.ts";
import * as S from "#/modules/session/schema.ts";
import { runOf, type Session } from "#/modules/session/session.ts";
import type { Trigger } from "#/modules/session/shapes.ts";
import * as issueQ from "#db/issue.sql.ts";
import * as qi from "#db/issue_input.sql.ts";
import * as qir from "#db/issue_run.sql.ts";
import * as qs from "#db/issue_subscription.sql.ts";

import { goesOnFrom, holdReasonOf } from "./inputs.ts";
import { handbackWords, releasedInputWords } from "./prompts.ts";

const refused = refuseIn(BizCode.ChannelRefused);
const readTrigger = jsonOf(S.Trigger, "issue_input.trigger_json");

/** What an issue's next helper is to be told when it is sent: the issue's words, or the ones it was started with. */
export interface Dispatch {
  readonly issue: string;
  /** The profile that is to take it. */
  readonly agent: string;
  readonly text: string;
  /** Where its helper answers. */
  readonly channel: string;
  readonly by: T.RunTrigger;
  readonly at: number;
}

/** An input waiting in a queued issue's pool. */
export interface QueuedInput {
  readonly issue: string;
  readonly trigger: Trigger;
}

export interface Intake {
  /** A recorded trigger routed: into the pool of the issue whose threads it is in (the user's words, or anything not
   * heard by the watch), else to its hearers, else to the orchestrator it names or the one of its place. Refusals are
   * ApiErrors (a trigger in two issues' threads). */
  readonly route: (trigger: Trigger, hearers?: readonly Hearer[]) => Promise<void>;
  /** A source's event recorded as a trigger and routed; the farm's own echo is neither. */
  readonly receive: (event: SourceEvent) => Promise<Accepted>;
  /** The threads whose words reach the issue's helper; a thread another issue has is refused. */
  readonly subscribe: (issue: string, threads: readonly string[]) => Promise<void>;
  /** A helper says an input is not its to take; the orchestrator is told why. */
  readonly decline: (session: string, envelope: string, reason: string) => Promise<void>;
  /** A dispatch held in the issue's pool for its next helper, in the caller's transaction; routed once it commits. */
  readonly queueDispatch: (dispatch: Dispatch) => Promise<void>;
  /** The issue's held dispatches returned: a session started on it. In the caller's transaction. */
  readonly withdrawDispatches: (issue: string) => Promise<void>;
  /** Every input of a queued issue: dispatches first, then in the order taken. */
  readonly queued: () => Promise<readonly QueuedInput[]>;
  /** An issue's inputs not returned, in the order taken. */
  readonly inputsOf: (issue: string) => Promise<readonly Trigger[]>;
  /** The issue a trigger is an input of. */
  readonly ownerOf: (trigger: string) => Promise<string | undefined>;
  /** inputs, delivered to the session hired on the issue with them, kept as its. */
  readonly forwarded: (issue: string, session: string, inputs: readonly Trigger[]) => Promise<void>;
  /** The runs that took the issue's inputs. */
  readonly runsOf: (issue: string) => Promise<T.Run[]>;
  /** A run took an input of issue (Session's IssueStarted). */
  readonly ranOn: (run: string, issue: string) => Promise<void>;
  /** The issues a run took: the helper's own (given) and those its run was told to have taken. */
  readonly issuesOfRun: (run: string, issue?: string) => Promise<readonly string[]>;
  /** What a restart or a failed route left unrouted, routed again (the crons' are cron.ts's). */
  readonly replay: () => Promise<void>;
  /** At startup: what was left routed, then each issue's threads and pool as the issue stands. */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface IntakeDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly session: Session;
  readonly channel: Channel;
}

export function issueIntake(deps: IntakeDeps): Intake {
  const { config, db, clock, core, agent: agents, session: sessions, channel: chat } = deps;
  const log = deps.log.child("intake");
  const tasks = new TaskGroup({ name: "intake", onError: (task, e) => log.error(`${task} failed:`, e) });
  const lock = new Semaphore(1);
  const locked = <A>(work: () => Promise<A>) => lock.with(work);
  const issueOf = (id: string) => core.state().issues.find((issue) => issue.id === id);
  const placeOf = (trigger: Trigger) => trigger.replyChannel ?? chat.defaultChannel();
  /** Who a trigger that names no session goes to: the orchestrator it is addressed to, or the one of its place. */
  const orchestratorFor = (trigger: Trigger) => {
    const addressed = trigger.meta.ingressRecipient;
    return addressed !== undefined && agents.isOrchestrator(addressed) ? addressed : chat.orchestratorIn(placeOf(trigger));
  };

  /** One pending timer per key: a later() for a key already waiting is dropped. The key is free again once it fires. */
  const timers = new Map<string, () => void>();
  let closed = false;
  const later = (key: string, work: () => Promise<void>) => {
    if (closed || timers.has(key)) return;
    timers.set(
      key,
      clock.after(0, () => {
        timers.delete(key);
        if (!closed) tasks.run(`intake: ${key}`, () => bestEffort(log, `intake: ${key}`, work));
      }),
    );
  };

  /** The input goes back to the orchestrator to be routed again: its helper declined it (reason), or the issue closed
   * before its helper took the user's words in (unreadOnly). */
  const retire = async (issue: T.Issue, trigger: Trigger, session: string | null, reason: string, unreadOnly: boolean): Promise<void> => {
    const recipient = orchestratorFor(trigger);
    await sessions.route(trigger, [
      {
        session: recipient,
        id: `returned:${issue.id}:${trigger.id}`,
        urgency: "queue",
        ...(session ? { previous: session } : {}),
        note: unreadOnly
          ? releasedInputWords(recipient, issue.number, trigger.card.readUri)
          : handbackWords(recipient, issue.number, reason, trigger.card.readUri),
        prepare: async () => {
          const current = await qi.existingIssueInput(db.sql, { trigger_id: trigger.id });
          if (!current || current.state === "returned") return false;
          if (unreadOnly && session) return (await qi.inputReceipt(db.sql, { session_id: session, trigger_id: trigger.id }))?.state !== "consumed";
          return true;
        },
        commit: async () => {
          await qi.returnIssueInput(db.sql, { trigger_id: trigger.id, reason });
        },
      },
    ]);
  };

  /** The issue's pool as the issue stands: on to its session what may go, held what may not, and once it closed, the
   * user's words its helper did not take back to the orchestrator. human: the user just spoke there. */
  const flush = async (id: string, human: boolean = false): Promise<void> => {
    const issue = issueOf(id);
    if (!issue) return;
    if (issue.status === "backlog") return;
    const assigned = assignedAgentOf(issue);
    const worker = latestSessionIdOf(issue);
    const recipient = assigned && agents.isOrchestrator(assigned) ? assigned : worker && sessions.live(worker).reachable ? worker : undefined;
    const closing = issue.status === "done" || (issue.status === "canceled" && issue.canceled !== "lost");
    const inputs = await qi.pendingIssueInputs(db.sql, { issue_id: id, recipient: recipient ?? null, closing });
    if (closing) {
      for (const input of inputs) {
        const trigger = readTrigger(input.trigger_json);
        if (trigger.actor.kind === "user") await retire(issue, trigger, input.session_id, "closed", true);
        else await qi.returnIssueInput(db.sql, { trigger_id: trigger.id, reason: "closed" });
      }
      return;
    }
    for (const input of inputs) {
      const trigger = readTrigger(input.trigger_json);
      const reason = holdReasonOf(trigger, issue, recipient, human);
      if (reason) {
        await qi.holdIssueInput(db.sql, { trigger_id: trigger.id, reason });
        continue;
      }
      if (!recipient) continue;
      const before = input.session_id;
      await sessions.route(trigger, [
        {
          session: recipient,
          issue: id,
          ...(before && before !== recipient ? { previous: before } : {}),
          prepare: async () => before === null || goesOnFrom(await qi.inputReceipt(db.sql, { session_id: before, trigger_id: trigger.id })),
          commit: async () => {
            await qi.forwardIssueInput(db.sql, { trigger_id: trigger.id, session_id: recipient });
          },
        },
      ]);
    }
  };
  const flushIssue = (issue: string, human?: boolean) => locked(() => flush(issue, human));

  const take = async (trigger: Trigger, hearers?: readonly Hearer[]): Promise<void> => {
    const existing = await qi.existingIssueInput(db.sql, { trigger_id: trigger.id });
    if (existing) {
      // A dispatch is in its pool before it is routed (queueDispatch).
      await sessions.route(trigger, [], deliveryScope(placeOf(trigger), existing.issue_id));
      if (existing.state === "held") await flush(existing.issue_id);
      return;
    }
    if (!hearers && (await sessions.isRouted(trigger.id))) return;
    // What the watch heard is in an issue's threads only when the user said it.
    const threads = hearers && trigger.actor.kind !== "user" ? [] : trigger.threads;
    const matches = await qs.subscribedIssues(db.sql, { keys: [...threads] });
    const ids = new Set(matches.map((row) => row.issue_id));
    for (const thread of threads.filter((thread) => thread.startsWith("issue:"))) {
      const id = thread.slice(6);
      if (issueOf(id) || (await issueQ.issueExists(db.sql, { id })) !== undefined) ids.add(id);
    }
    if (ids.size > 1) throw refused(t("server.mailbox.ambiguous"));
    const issue = ids.values().next().value;
    if (issue) {
      await qi.holdIssueTrigger(db.sql, { issue_id: issue, trigger_id: trigger.id, created_at: clock.now() });
      await sessions.route(trigger, [], deliveryScope(placeOf(trigger), issue));
      await flush(issue, trigger.actor.kind === "user");
      return;
    }
    const to: readonly Delivery[] = hearers
      ? hearers.map((h) => ({
          session: h.session,
          heard: { reason: h.reason, wakes: h.wakes, ...(h.heldBy ? { heldBy: h.heldBy } : {}) },
          role: h.role,
          event: h.event,
        }))
      : [{ session: orchestratorFor(trigger) }];
    await sessions.route(trigger, to);
  };
  const route = (trigger: Trigger, hearers?: readonly Hearer[]) => locked(() => take(trigger, hearers));

  const subscribe = async (issue: string, threads: readonly string[]): Promise<void> => {
    if (!issueOf(issue)) throw missing(t("server.issue.issueRef", { ref: issue }), [lookIn.issue]);
    await db.tx(async () => {
      for (const thread of new Set(threads)) {
        const owned = await qs.subscribeIssue(db.sql, { issue_id: issue, thread_key: thread });
        if (owned.length === 0) throw refused(t("server.mailbox.subscriptionTaken", { thread }));
      }
    });
  };

  const decline = async (session: string, envelope: string, reason: string): Promise<void> => {
    const why = reason.trim();
    if (!why) throw refused(t("server.issue.noTitle"));
    const declined = await locked(async () => {
      const delivered = await qi.deliveredTrigger(db.sql, { session_id: session, envelope_id: envelope });
      if (!delivered) return false;
      const input = await qi.existingIssueInput(db.sql, { trigger_id: delivered.trigger_id });
      if (!input) return false;
      if (input.session_id !== session) throw refused(t("server.mailbox.notOwned"));
      const issue = issueOf(input.issue_id);
      if (!issue) return false;
      if (input.state !== "returned") await retire(issue, readTrigger(input.trigger_json), session, why, false);
      return true;
    });
    if (!declined) throw missing(t("server.issue.issueRef", { ref: envelope }), [lookIn.issue]);
  };

  const bindIssue = (issue: T.Issue) =>
    subscribe(issue.id, [`issue:${issue.id}`, ...(issue.repo && issue.pullRequest ? [`github:${issue.repo}#${issue.pullRequest.number}`] : [])]);
  const onFact = (fact: T.ServerEvent) =>
    bestEffort(log, "intake: issue routing", async () => {
      if (fact.type === "issueChanged") {
        await bindIssue(fact.issue);
        if (fact.issue.status === "done" || fact.issue.status === "canceled") await flushIssue(fact.issue.id);
        else later(`issue:${fact.issue.id}`, () => flushIssue(fact.issue.id));
      } else if (fact.type === "sessionChanged" && fact.session.issue && issueOf(fact.session.issue) !== undefined) {
        const issue = fact.session.issue;
        later(`issue:${issue}`, () => flushIssue(issue));
      } else if (
        fact.type === "channelChanged" &&
        fact.channel.subjectKind === "issue" &&
        fact.channel.subjectId &&
        issueOf(fact.channel.subjectId) !== undefined
      ) {
        await subscribe(fact.channel.subjectId, [`channel:${fact.channel.id}`]);
      }
    });
  const { changes } = core.transitions();
  tasks.run("issue routing", async (signal) => {
    try {
      for (let r = await changes.next(signal); r.done !== true; r = await changes.next(signal)) await onFact(r.value.fact);
    } finally {
      changes.close();
    }
  });

  const replay = () =>
    sessions.unrouted(async (trigger) => {
      if (trigger.source !== "cron") await route(trigger);
    });
  tasks.run("replay", async (signal) => {
    while (true) {
      await clock.sleep(config.chat.retryWakeMs, signal);
      await replay();
    }
  });

  return {
    route,
    receive: async (event) => {
      if (event.selfEcho === true) return {};
      const trigger = await sessions.recordTrigger(event);
      await route(trigger);
      return { trigger };
    },
    subscribe,
    decline,
    queueDispatch: async (d) => {
      const trigger = await sessions.recordTrigger({
        source: "workbench",
        key: newId(),
        actor: { kind: "system", id: "system" },
        text: d.text,
        threads: [`issue:${d.issue}`],
        addressed: "thread_owner",
        replyChannel: d.channel,
        meta: { ingressRecipient: d.agent, issue: d.issue, trigger: d.by, dispatch: true },
        at: d.at,
      });
      await qi.holdIssueTrigger(db.sql, { issue_id: d.issue, trigger_id: trigger.id, created_at: clock.now() });
      await qi.supersedeDispatch(db.sql, { issue_id: d.issue, trigger_id: trigger.id });
      await db.afterCommit(() => bestEffort(log, `intake: route ${trigger.id}`, () => route(trigger)));
    },
    withdrawDispatches: async (issue) => {
      await qi.retireQueuedDispatches(db.sql, { issue_id: issue });
    },
    queued: async () => (await qi.inputsOfQueuedIssues(db.sql)).map((row) => ({ issue: row.issue_id, trigger: readTrigger(row.trigger_json) })),
    inputsOf: async (issue) => (await qi.inputsOfIssue(db.sql, { issue_id: issue })).map((row) => readTrigger(row.trigger_json)),
    ownerOf: async (trigger) => (await qi.existingIssueInput(db.sql, { trigger_id: trigger }))?.issue_id,
    forwarded: (issue, session, inputs) =>
      db.tx(async () => {
        const at = clock.now();
        for (const input of inputs) {
          await qi.holdIssueTrigger(db.sql, { trigger_id: input.id, issue_id: issue, created_at: at });
          await qi.forwardIssueInput(db.sql, { trigger_id: input.id, session_id: session });
        }
      }),
    runsOf: async (issue) => (await qir.runsOfIssue(db.sql, { issue_id: issue })).map(runOf),
    ranOn: async (run, issue) => {
      await qir.linkRunIssue(db.sql, { run, issue });
    },
    issuesOfRun: async (run, issue) => [...new Set([...(issue ? [issue] : []), ...(await qir.runIssues(db.sql, { run })).map((row) => row.issue)])],
    replay,
    boot: async () => {
      await replay();
      for (const issue of core.state().issues)
        await bestEffort(log, `intake: issue ${issue.id}`, async () => {
          await bindIssue(issue);
          await flushIssue(issue.id);
        });
    },
    close: async () => {
      closed = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
      await tasks.close();
    },
  };
}
