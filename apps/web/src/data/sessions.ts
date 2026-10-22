// A session's log as the views read it: the issue pages (workbench and farm), the trajectory and the work log.

import { type Accessor, createEffect, createSignal } from "solid-js";
import type { SessionEvent } from "@vibevalley/protocol";
import { api } from "./api";
import { subscribeLive } from "./live";
import { queries } from "./query";
import { SessionLogs } from "./sessionLogs";

// SessionLogs deduplicates active readers. A later observation must not borrow a request started before it subscribed.
let readNumber = 0;
const logs = new SessionLogs(
  (id) => queries.fetchQuery({ queryKey: ["session-events", id, ++readNumber], queryFn: () => api.session.events({ id }), gcTime: 0 }),
  subscribeLive,
);

/** A session's current retained log (the orchestrator's is "orchestrator"). The observer never suspends the page's other reads. */
export function createSessionEvents(id: Accessor<string>, enabled: Accessor<boolean>): Accessor<SessionEvent[]> {
  const [steps, setSteps] = createSignal<SessionEvent[]>([]);
  createEffect(
    () => (enabled() ? id() : undefined),
    (session) => {
      setSteps([]);
      if (session !== undefined) return logs.subscribe(session, setSteps);
    },
  );
  return steps;
}
