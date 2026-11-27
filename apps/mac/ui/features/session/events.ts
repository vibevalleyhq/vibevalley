import type { SessionEventPage } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { subscribeLive } from "../../infra/frame";
import { defineQuery, retryRead, useQueryClient, type QueryClient } from "../../infra/query";
import { type Accessor, createEffect, createSignal } from "../../infra/solid";
import { emptyProjectionState, SessionLogs, type SessionProjectionState } from "./runs";

const eventQuery = defineQuery({
  key: (a: { id: string; read: number }) => ["session-events", a.id, a.read],
  fetch: (a, context): Promise<SessionEventPage> => api.session.event.list({ id: a.id }, context),
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

/** A session's current retained log and Rust trajectory projection (the orchestrator's is `"orchestrator"`). */
export function createSessionProjection(id: Accessor<string>, enabled: Accessor<boolean>): Accessor<SessionProjectionState> {
  const logs = logsFor(useQueryClient());
  const [state, setState] = createSignal<SessionProjectionState>(emptyProjectionState);
  createEffect(
    () => (enabled() ? id() : undefined),
    (session) => {
      setState(emptyProjectionState);
      return session !== undefined ? logs.subscribeProjection(session, setState) : undefined;
    },
  );
  return state;
}
