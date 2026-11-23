import type { SessionEvent } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { subscribeLive } from "../../infra/frame";
import { defineQuery, retryRead, useQueryClient, type QueryClient } from "../../infra/query";
import { type Accessor, createEffect, createSignal } from "../../infra/solid";
import { SessionLogs } from "./runs";

const eventQuery = defineQuery({
  key: (a: { id: string; read: number }) => ["session-events", a.id, a.read],
  fetch: async (a, context) => (await api.session.event.list({ id: a.id }, context)).events,
  gcTime: 0,
  ...retryRead,
});
const logScopes = new WeakMap<QueryClient, SessionLogs>();
function logsFor(client: QueryClient) {
  const existing = logScopes.get(client);
  if (existing) return existing;
  let read = 0;
  const logs = new SessionLogs((id) => client.fetch(eventQuery({ id, read: ++read })), subscribeLive);
  logScopes.set(client, logs);
  return logs;
}

/** A session's current retained log (the orchestrator's is "orchestrator"). The observer never suspends the page's other reads. */
export function createSessionEvents(id: Accessor<string>, enabled: Accessor<boolean>): Accessor<SessionEvent[]> {
  const logs = logsFor(useQueryClient());
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

/** A single run's retained steps, only notified when that run's slice changes. */
export function createRunEvents(id: Accessor<string>, run: Accessor<string | undefined>, enabled: Accessor<boolean>): Accessor<SessionEvent[]> {
  const logs = logsFor(useQueryClient());
  const [steps, setSteps] = createSignal<SessionEvent[]>([]);
  createEffect(
    () => {
      if (!enabled()) return undefined;
      const session = id();
      const targetRun = run();
      return targetRun !== undefined ? ([session, targetRun] as const) : undefined;
    },
    (target) => {
      setSteps([]);
      return target !== undefined ? logs.subscribeRun(target[0], target[1], setSteps) : undefined;
    },
  );
  return steps;
}
