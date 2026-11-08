import { Effect } from "effect";

import type { MediaHandlers } from "@vibevalley/protocol/api";

import { Media } from "#/media/media.ts";

export const mediaHandlers = Effect.gen(function* () {
  const media = yield* Media;
  return {
    "media.input.create": media.inputs.create,
    "media.input.get": ({ id }) => media.inputs.get(id),
    "media.input.list": media.inputs.list,
    "media.input.delete": ({ id }) => media.inputs.delete(id),
    "media.input.previewDelete": ({ id }) => media.inputs.previewDelete(id),
    "media.understanding.create": media.createUnderstanding,
    "media.understanding.previewCleanup": ({ id }) => media.previewUnderstandingCleanup(id),
    "media.understanding.cleanup": ({ id }) => media.cleanupUnderstanding(id),
    "media.image.create": (input) => media.createImage(input, { kind: "owner" }),
    "media.job.get": ({ id }) => media.get(id),
    "media.job.list": () => media.list(),
    "media.job.cancel": ({ id }) => media.cancel(id),
    "media.job.download": ({ id }) => media.retryDownload(id),
  } satisfies MediaHandlers;
});
