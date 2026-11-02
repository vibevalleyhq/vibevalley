import { Clock, Cause, Context, Effect, Layer, Stream } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { newId } from "@/base/ids.ts";
import { Channel } from "@/channel/chat.ts";
import { Ingress } from "@/ingress/ingress.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import { type NotAnswered } from "@/session/host.ts";

import { orchestratorModel } from "./model.ts";
import type { Answer } from "./openai.ts";

const closeResponse = (mailbox: Mailbox["Service"], id: string, caller: ReturnType<Mailbox["Service"]["openResponse"]>["caller"]) =>
  Effect.sync(() => {
    caller.end();
    mailbox.dropResponse(id);
  });

/** A live API/phone response whose durable input goes through Ingress and Mailbox before the orchestrator sees it. */
const responseAnswerer =
  (ingress: Ingress["Service"], mailbox: Mailbox["Service"], on: "api" | "phone") =>
  (model: string): Answer<NotAnswered> | undefined => {
    if (model !== orchestratorModel) return undefined;
    return (text) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const response = mailbox.openResponse(true);
          yield* ingress
            .owner({
              source: "voice",
              text,
              envelope: newId(),
              responsePort: response.id,
              voiceMode: on === "phone" ? "conversation" : "api",
            })
            .pipe(Effect.catchCause((cause) => Effect.sync(() => response.caller.fail(Cause.squash(cause)))));
          return response.caller.words.pipe(Stream.ensuring(closeResponse(mailbox, response.id, response.caller)));
        }),
      );
  };

/** A call-side update or ring reason. The response port is process-local; the issue-source envelope survives without it. */
const responseBrief = (
  ingress: Ingress["Service"],
  channel: Channel["Service"],
  mailbox: Mailbox["Service"],
  line: string,
): Effect.Effect<string, NotAnswered> =>
  Effect.gen(function* () {
    const response = mailbox.openResponse(false);
    yield* ingress
      .accept({
        source: "workbench",
        key: newId(),
        actor: { kind: "system", id: "system" },
        addressed: "direct",
        threads: [],
        replyChannel: channel.defaultChannel(),
        text: line,
        meta: { ingressRecipient: defaultOrchestrator, responsePort: response.id },
        at: yield* Clock.currentTimeMillis,
      })
      .pipe(Effect.catchCause((cause) => Effect.sync(() => response.caller.fail(Cause.squash(cause)))));
    return yield* Stream.mkString(response.caller.words).pipe(
      Effect.map((said) => said.trim()),
      Effect.ensuring(closeResponse(mailbox, response.id, response.caller)),
    );
  });

export class OrchestratorResponse extends Context.Service<
  OrchestratorResponse,
  {
    readonly answerer: (on: "api" | "phone") => (model: string) => Answer<NotAnswered> | undefined;
    readonly brief: (line: string) => Effect.Effect<string, NotAnswered>;
  }
>()("vibevalley/OrchestratorResponse") {
  static readonly layer = Layer.effect(
    OrchestratorResponse,
    Effect.gen(function* () {
      const channel = yield* Channel;
      const ingress = yield* Ingress;
      const mailbox = yield* Mailbox;
      return OrchestratorResponse.of({
        answerer: (on) => responseAnswerer(ingress, mailbox, on),
        brief: Effect.fn("OrchestratorResponse.brief")((line) => responseBrief(ingress, channel, mailbox, line)),
      });
    }),
  );
}
