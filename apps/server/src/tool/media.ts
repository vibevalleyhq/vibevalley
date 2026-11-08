import { Effect } from "effect";

import { t } from "@vibevalley/i18n";

import { Media } from "#/media/media.ts";

import { callerOf, refuse, tool, type Who } from "./schemas.ts";

export const mediaTools = Effect.gen(function* () {
  const media = yield* Media;
  return (who: Who) => [
    tool(
      "media.image.create",
      Effect.fn("Tool.mediaImageCreate")(function* (input) {
        const caller = yield* callerOf(who);
        if (caller.actor.kind !== "orchestrator") return yield* refuse(t("server.media.ownerRequired"));
        return JSON.stringify(
          yield* media.createImage(input, { kind: "orchestrator", agent: caller.agent, channel: caller.here, forOwner: caller.actor.forOwner }),
        );
      }),
    ),
    tool("media.job.get", ({ id }) => media.get(id).pipe(Effect.map(JSON.stringify))),
    tool("media.job.cancel", ({ id }) => media.cancel(id).pipe(Effect.map(JSON.stringify))),
    tool("media.job.download", ({ id }) => media.retryDownload(id).pipe(Effect.map(JSON.stringify))),
    tool("media.job.list", () => media.list().pipe(Effect.map(JSON.stringify))),
  ];
});
