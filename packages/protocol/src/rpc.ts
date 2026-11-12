import { z } from "zod";

import * as S from "./schema";

/** Where the subscriptions are served. One is read as `GET <subscriptionPath>/<name>?payload=<JSON of its payload>`,
 * answered `text/event-stream`: each event one `data: <JSON>` line decoded with its `event` Schema. A payload that does
 * not decode, or a refusal before the first event (no such channel…), is answered as any route is: a JSON ApiError
 * envelope with its status, not a stream. Once streaming, the server ends the stream rather than send an error. */
export const subscriptionPath = "/api/v1/subscribe";

/** Each subscription's payload and the Schema of each event it then sends, by name. */
export const subscriptions = {
  /** What changed in a channel after the revision after, then each change from now on, each the message as it now is. */
  "channel.follow": { payload: z.object({ id: z.string(), after: z.number() }), event: S.ChannelEvent },
  /** The turn reports in any channel after the one with this id (by message id, which sorts by time), or the newest
   * when absent, then each report from now on. */
  "channel.reports": { payload: z.object({ after: z.exactOptional(z.string()) }), event: S.ChannelEvent },
  /** A blocks artifact's changes after this seq, then each batch from now on. */
  "artifact.follow": { payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEvent },
  /** An artifact's suggestions as they now are, then the whole list after each change. */
  "artifact.suggestion.follow": { payload: z.object({ id: z.string() }), event: S.SuggestionEvent },
} as const;

export type SubscriptionName = keyof typeof subscriptions;

/** Each subscription's payload and event, as types. */
export type Subscriptions = {
  readonly [K in SubscriptionName]: {
    readonly payload: z.output<(typeof subscriptions)[K]["payload"]>;
    readonly event: z.output<(typeof subscriptions)[K]["event"]>;
  };
};

/** The URL path one subscription with this payload is read at. */
export const subscriptionUrl = <K extends SubscriptionName>(name: K, payload: Subscriptions[K]["payload"]): string =>
  `${subscriptionPath}/${name}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
