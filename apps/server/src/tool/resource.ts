import { Effect, Schema } from "effect";

import { resourceWords } from "@/resource/prompts.ts";
import { Resource, ResourceRequest } from "@/resource/resource.ts";

import { callerOf, customTool, type Who } from "./definition.ts";
import { toolParameters } from "./schemas.ts";

export const resourceTools = Effect.gen(function* () {
  const resource = yield* Resource;
  return (who: Who) =>
    customTool(
      "resource_read",
      resourceWords.description,
      toolParameters(ResourceRequest),
      Schema.decodeUnknownEffect(ResourceRequest),
      Effect.fn("Tool.resourceRead")(function* (input) {
        const caller = yield* callerOf(who);
        return JSON.stringify(yield* resource.read(caller.session || caller.agent, input));
      }),
    );
});
