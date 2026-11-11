import { Effect } from "effect";

import { t } from "@vibevalley/i18n";

import { jsonText } from "#/base/json.ts";
import { Media } from "#/modules/media/media.ts";

import { callerOf, refuse, tool, type Who } from "./schemas.ts";

export const mediaTools = Effect.gen(function* () {
  const media = yield* Media;
  return (who: Who) => [
    tool(
      "media.image.create",
      Effect.fn("Tool.mediaImageCreate")(function* (input) {
        const caller = yield* callerOf(who);
        if (caller.actor.kind !== "agent" || caller.actor.role !== "orchestrator") return yield* refuse(t("server.media.userRequired"));
        const imageCreated = yield* media.createImage(input, {
          kind: "orchestrator",
          agent: caller.agent,
          channel: caller.here,
          forUser: caller.actor.forUser === true,
        });
        return yield* jsonText(imageCreated);
      }),
    ),
    tool(
      "media.understanding.start",
      Effect.fn("Tool.mediaUnderstandingStart")(function* ({ id }) {
        const caller = yield* callerOf(who);
        if (caller.actor.kind !== "agent" || caller.actor.role !== "orchestrator") return yield* refuse(t("server.media.userRequired"));
        const understandingStarted = yield* media.startUnderstanding(id, {
          kind: "orchestrator",
          agent: caller.agent,
          channel: caller.here,
          forUser: caller.actor.forUser === true,
        });
        return yield* jsonText(understandingStarted);
      }),
    ),
    tool(
      "media.speech.create",
      Effect.fn("Tool.mediaSpeechCreate")(function* (input) {
        const caller = yield* callerOf(who);
        if (caller.actor.kind !== "agent" || caller.actor.role !== "orchestrator") return yield* refuse(t("server.media.userRequired"));
        const speechCreated = yield* media.createSpeech(input, {
          kind: "orchestrator",
          agent: caller.agent,
          channel: caller.here,
          forUser: caller.actor.forUser === true,
        });
        return yield* jsonText(speechCreated);
      }),
    ),
    tool(
      "media.dialogue.create",
      Effect.fn("Tool.mediaSpeakersCreate")(function* (input) {
        const caller = yield* callerOf(who);
        if (caller.actor.kind !== "agent" || caller.actor.role !== "orchestrator") return yield* refuse(t("server.media.userRequired"));
        const speakersCreated = yield* media.createSpeakers(input, {
          kind: "orchestrator",
          agent: caller.agent,
          channel: caller.here,
          forUser: caller.actor.forUser === true,
        });
        return yield* jsonText(speakersCreated);
      }),
    ),
    tool(
      "media.voiceDesign.create",
      Effect.fn("Tool.mediaVoiceDesignCreate")(function* (input) {
        const caller = yield* callerOf(who);
        if (caller.actor.kind !== "agent" || caller.actor.role !== "orchestrator") return yield* refuse(t("server.media.userRequired"));
        const voiceDesignCreated = yield* media.createVoiceDesign(input, {
          kind: "orchestrator",
          agent: caller.agent,
          channel: caller.here,
          forUser: caller.actor.forUser === true,
        });
        return yield* jsonText(voiceDesignCreated);
      }),
    ),
    tool("media.job.get", ({ id }) => media.get(id).pipe(Effect.flatMap(jsonText))),
    tool("media.job.cancel", ({ id }) => media.cancel(id).pipe(Effect.flatMap(jsonText))),
    tool("media.job.download", ({ id }) => media.retryDownload(id).pipe(Effect.flatMap(jsonText))),
    tool("media.job.list", () => media.list().pipe(Effect.flatMap(jsonText))),
  ];
});
