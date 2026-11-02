import { Effect, Semaphore, Stream } from "effect";

import { Core } from "@/core/core.ts";
import { bestEffort } from "@/infra/log.ts";
import { Issue } from "@/issue/issue.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";

import type { Ingress } from "./ingress.ts";

export const issueInputs = Effect.fn("Ingress.issueInputs")(function* (accept: Ingress["Service"]["accept"]) {
  const issues = yield* Issue;
  const mailbox = yield* Mailbox;
  const core = yield* Core;
  const lock = yield* Semaphore.make(1);
  const drain = Effect.gen(function* () {
    const pending = yield* issues.pendingDispatches;
    yield* Effect.forEach(
      pending,
      (dispatch) =>
        Effect.gen(function* () {
          yield* accept({
            source: "workbench",
            key: dispatch.id,
            actor: { kind: "system", id: "system" },
            text: dispatch.text,
            threads: [`issue:${dispatch.issue}`],
            addressed: "thread_owner",
            replyChannel: dispatch.channel,
            meta: { ingressRecipient: dispatch.agent, issue: dispatch.issue, trigger: dispatch.by, dispatch: true },
            at: dispatch.at,
          });
          yield* issues.acknowledgeDispatch(dispatch.id);
        }).pipe(bestEffort(`ingress: issue dispatch ${dispatch.id}`)),
      { discard: true },
    );
    if (pending.length > 0) yield* issues.tryQueued(yield* mailbox.queuedInputs);
  }).pipe(lock.withPermits(1));
  const refresh = Effect.gen(function* () {
    yield* drain;
    yield* issues.tryQueued(yield* mailbox.queuedInputs);
  });
  yield* Effect.forkScoped(Stream.runForEach(yield* core.subscribe, (fact) => (fact.type === "issue" ? drain : Effect.void)));
  return { refresh };
});
