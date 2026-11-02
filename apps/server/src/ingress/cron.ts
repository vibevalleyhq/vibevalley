import { Effect, Semaphore, Stream } from "effect";

import { Cron } from "@/cron/cron.ts";
import { dueText } from "@/cron/due.ts";
import { bestEffort } from "@/infra/log.ts";
import { Issue } from "@/issue/issue.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";

import type { Ingress } from "./ingress.ts";

export const cronInputs = Effect.fn("Ingress.cronInputs")(function* (record: Ingress["Service"]["record"]) {
  const crons = yield* Cron;
  const issues = yield* Issue;
  const mailbox = yield* Mailbox;
  const lock = yield* Semaphore.make(1);
  const drain = Effect.gen(function* () {
    yield* Effect.forEach(
      yield* crons.pendingOccurrences,
      (due) =>
        Effect.gen(function* () {
          const s = due.cron;
          const thread = `cron:${s.id}`;
          const trigger = yield* record({
            source: "cron",
            key: due.id,
            actor: { kind: "system", id: s.id },
            text: dueText(s, due.missed),
            data: s,
            threads: [thread],
            addressed: "thread_owner",
            replyChannel: s.channel,
            meta: { cron: s.id, trigger: { kind: "cron", cron: s.id, ...(due.missed ? { missed: true } : {}) } },
            at: s.lastRun ?? s.created,
          });
          if (!trigger) return;
          if (!(yield* mailbox.registered(trigger.id))) {
            const issue = yield* issues.scheduled(due, trigger);
            yield* mailbox.subscribe(issue.id, [thread]);
            yield* mailbox.receive(trigger);
          } else {
            const issue = yield* mailbox.ownerOf(trigger.id);
            if (issue) yield* mailbox.subscribe(issue, [thread]);
          }
          yield* crons.acknowledge(due.id);
        }).pipe(bestEffort(`ingress: cron occurrence ${due.id}`)),
      { discard: true },
    );
  }).pipe(lock.withPermits(1));
  yield* Effect.forkScoped(Stream.runForEach(yield* crons.due, () => drain));
  return { refresh: drain };
});
