import { Clock, Cause, Effect, Stream } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import { type Channel } from "#/channel/channel.ts";
import { type Ingress } from "#/ingress/ingress.ts";
import { Caller, type NotAnswered } from "#/session/host.ts";

import type { Answer } from "./openai.ts";
import { orchestratorModel } from "./situation.ts";

/** The live API/phone responses, from opening a port to dropping it once its words are read. */
export const makeResponses = (ingress: Ingress["Service"], channel: Channel["Service"]) => {
  const responses = new Map<string, Caller>();
  let latestResponse = "";

  const open = (latest: boolean) => {
    const id = newId();
    const caller = new Caller();
    if (latest) {
      if (latestResponse) responses.get(latestResponse)?.end();
      latestResponse = id;
    }
    responses.set(id, caller);
    return { id, caller };
  };

  const take = (id: string) => {
    const caller = responses.get(id);
    responses.delete(id);
    if (latestResponse === id) latestResponse = "";
    return caller;
  };

  const drop = (id: string) => {
    responses.delete(id);
    if (latestResponse === id) latestResponse = "";
  };

  const closeAll = () => {
    for (const caller of responses.values()) caller.end();
    responses.clear();
    latestResponse = "";
  };

  const closeResponse = (id: string, caller: Caller) =>
    Effect.sync(() => {
      caller.end();
      drop(id);
    });

  /** A live API/phone response whose durable input goes through Ingress before the orchestrator sees it. */
  const answerer =
    (on: "api" | "phone") =>
    (model: string): Answer<NotAnswered> | undefined => {
      if (model !== orchestratorModel) return undefined;
      return (text) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const response = open(true);
            yield* ingress
              .owner({
                source: "voice",
                text,
                envelope: newId(),
                responsePort: response.id,
                voiceMode: on === "phone" ? "conversation" : "api",
              })
              .pipe(Effect.catchCause((cause) => Effect.sync(() => response.caller.fail(Cause.squash(cause)))));
            return response.caller.words.pipe(Stream.ensuring(closeResponse(response.id, response.caller)));
          }),
        );
    };

  /** A call-side update or ring reason. The response port is process-local; the issue-source envelope survives without it. */
  const brief = (line: string): Effect.Effect<string, NotAnswered> =>
    Effect.gen(function* () {
      const response = open(false);
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
        Effect.ensuring(closeResponse(response.id, response.caller)),
      );
    });

  return { open, take, drop, closeAll, answerer, brief };
};
