import { z } from "zod";

import * as S from "./schema";

/** Each subscription's payload and the Schema of each event it then sends, by name. */
export const subscriptions = {
  /** What changed in a channel after the revision after, then each change from now on, each the message as it now is. */
  "channel.follow": { payload: z.object({ id: z.string(), after: z.number() }), event: S.ChannelEvent },
  /** The turn reports in any channel after the one with this id (by message id, which sorts by time), or the newest
   * when absent, then each report from now on. */
  "channel.reports": { payload: z.object({ after: z.exactOptional(z.string()) }), event: S.ChannelEvent },
  /** A blocks artifact's changes after this seq, then each batch from now on. */
  "artifact.follow": { payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEvent },
  /** A store artifact's entry changes after this seq, then each batch from now on. */
  "artifact.entry.follow": { payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEntryEvent },
  /** An artifact's suggestions as they now are, then the whole list after each change. */
  "artifact.suggestion.follow": { payload: z.object({ id: z.string() }), event: S.SuggestionEvent },
} as const;

export type SubscriptionName = keyof typeof subscriptions;
