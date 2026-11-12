import type { AttachmentHandlers } from "@vibevalley/protocol/api";

import type { Attachment } from "#/modules/attachment/attachment.ts";

export function attachmentHandlers(deps: { readonly attachment: Attachment }): AttachmentHandlers {
  const files = deps.attachment;
  return {
    "attachment.create": (upload) => files.attach(upload),
  };
}
