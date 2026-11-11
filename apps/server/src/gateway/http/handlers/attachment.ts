import { Effect } from "effect";

import type { AttachmentHandlers } from "@vibevalley/protocol/api";

import { Attachment } from "#/modules/attachment/attachment.ts";

export const attachmentHandlers = Effect.gen(function* () {
  const files = yield* Attachment;
  const done: AttachmentHandlers = {
    "attachment.create": (upload) => files.attach(upload),
  };
  return done;
});
