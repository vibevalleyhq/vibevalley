import { type Accessor, createEffect, createSignal } from "solid-js";

import type { SessionEvent } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { subscribeLive } from "#/infra/frame.ts";
import { queries } from "#/infra/query.ts";

import { SessionLogs } from "./runs";

// SessionLogs deduplicates active readers. A later observation must not borrow a request started before it subscribed.
let readNumber = 0;
const logs = new SessionLogs(
  (id) => queries.fetchQuery({ queryKey: ["session-events", id, ++readNumber], queryFn: () => api.session.event.list({ id }), gcTime: 0 }),
  subscribeLive,
);

/** A session's current retained log (the orchestrator's is "orchestrator"). The observer never suspends the page's other reads. */
export function createSessionEvents(id: Accessor<string>, enabled: Accessor<boolean>): Accessor<SessionEvent[]> {
  const [steps, setSteps] = createSignal<SessionEvent[]>([]);
  createEffect(
    () => (enabled() ? id() : undefined),
    (session) => {
      setSteps([]);
      return session !== undefined ? logs.subscribe(session, setSteps) : undefined;
    },
  );
  return steps;
}
