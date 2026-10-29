import { Effect, PubSub } from "effect";

/** An unbounded PubSub shut down when the scope that made it (its service's layer) closes, so a subscriber's stream ends
 * then instead of waiting for ever. */
export const scopedPubSub = <A>() => Effect.acquireRelease(PubSub.unbounded<A>(), PubSub.shutdown);
