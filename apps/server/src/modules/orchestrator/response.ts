import type { Clock } from "@vibevalley/async";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { Caller } from "#/modules/session/host.ts";
import type { Session } from "#/modules/session/session.ts";

import type { Answer } from "./openai.ts";
import { orchestratorModel } from "./situation.ts";

/** The live API/phone responses, from opening a port to dropping it once its words are read. */
/** A brief is recorded with the sessions and routed by the issues' intake, to the orchestrator it names. */
export const makeResponses = (sessions: Pick<Session, "recordTrigger">, issues: Pick<Issue, "route">, channel: Channel, clock: Clock) => {
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

  const closeResponse = (id: string, caller: Caller) => {
    caller.end();
    drop(id);
  };

  /** A live API/phone response whose durable input goes through Channel before the orchestrator sees it. */
  const answerer =
    (on: "api" | "phone") =>
    (model: string): Answer | undefined => {
      if (model !== orchestratorModel) return undefined;
      return async function* (text, signal) {
        const response = open(true);
        try {
          try {
            await channel.say({
              source: "voice",
              text,
              sendKey: newId(),
              responsePort: response.id,
              voiceMode: on === "phone" ? "conversation" : "api",
            });
          } catch (e) {
            // Not taken in: the reader below gets the failure as NotAnswered.
            response.caller.fail(e);
          }
          yield* response.caller.words(signal);
        } finally {
          closeResponse(response.id, response.caller);
        }
      };
    };

  /** A call-side update or ring reason. The response port is process-local. Throws NotAnswered. */
  const brief = async (line: string, signal?: AbortSignal): Promise<string> => {
    // A caller that left before it began takes no line: nothing is started to wait for.
    signal?.throwIfAborted();
    const response = open(false);
    try {
      try {
        const trigger = await sessions.recordTrigger({
          source: "workbench",
          key: newId(),
          actor: { kind: "system", id: "system" },
          addressed: "direct",
          threads: [],
          replyChannel: channel.defaultChannel(),
          text: line,
          meta: { ingressRecipient: defaultOrchestrator, responsePort: response.id },
          at: clock.now(),
        });
        await issues.route(trigger);
      } catch (e) {
        // Not taken in: the reader below gets the failure as NotAnswered.
        response.caller.fail(e);
      }
      let said = "";
      for await (const words of response.caller.words(signal)) said += words;
      return said.trim();
    } finally {
      closeResponse(response.id, response.caller);
    }
  };

  return { open, take, drop, closeAll, answerer, brief };
};
