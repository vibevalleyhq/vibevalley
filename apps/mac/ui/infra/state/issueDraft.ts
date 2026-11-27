import type { Attachment } from "@vibevalley/protocol";

import { defineAtom } from "./atom";

export interface PendingNewIssueDraft {
  readonly text: string;
  readonly attachmentFiles: readonly Attachment[];
  readonly repo?: string;
}

/** Prefilled issue draft handed off from a channel message when promoting to an issue. */
export const pendingNewIssue = defineAtom<PendingNewIssueDraft | undefined>(undefined);
