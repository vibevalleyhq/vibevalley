import { z } from "zod";

import type { Caller } from "./endpoint";
import * as S from "./schema";

const userAndRemote: readonly Caller[] = ["user", "remote"];

/** Each subscription's payload, allowed callers, and the Schema of each event it then sends, by name. */
export const subscriptions = {
  /** What changed in a channel after the revision after, then each change from now on, each the message as it now is. */
  "channel.follow": { can: userAndRemote, payload: z.object({ id: z.string(), after: z.number() }), event: S.ChannelEvent },
  /** The turn reports in any channel after the one with this id (by message id, which sorts by time), or the newest
   * when absent, then each report from now on. */
  "channel.reports": { can: userAndRemote, payload: z.object({ after: z.exactOptional(z.string()) }), event: S.ChannelEvent },
  /** A blocks artifact's changes after this seq, then each batch from now on. */
  "artifact.follow": { can: userAndRemote, payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEvent },
  /** A store artifact's entry changes after this seq, then each batch from now on. */
  "artifact.entry.follow": { can: userAndRemote, payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEntryEvent },
  /** An artifact's suggestions as they now are, then the whole list after each change. */
  "artifact.suggestion.follow": { can: userAndRemote, payload: z.object({ id: z.string() }), event: S.SuggestionEvent },
  /** An artifact's ephemeral live presence peers as a snapshot, then incremental upserts and removals. */
  "artifact.presence.follow": { can: userAndRemote, payload: S.ArtifactPresenceFollowRequest, event: S.ArtifactPresenceEvent },
  /** One session's state, pending permissions/interactions, and live trajectory events after afterSeq. */
  "session.watch": { can: userAndRemote, payload: z.object({ id: z.string(), afterSeq: z.exactOptional(z.number()) }), event: S.SessionWatchEvent },
} as const;

export type SubscriptionName = keyof typeof subscriptions;
