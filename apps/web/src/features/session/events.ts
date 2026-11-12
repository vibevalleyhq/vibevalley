import { type Accessor, createEffect, createSignal } from "solid-js";
import { z } from "zod";

import type { SessionEvent } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { subscribeLive } from "#/infra/frame.ts";
import { defineQuery, retryRead, useQueryClient, type QueryClient } from "#/infra/query.ts";

import { SessionLogs } from "./runs";

const eventQuery = defineQuery({
  schema: z.array(S.SessionEvent),
  key: (a: { id: string; read: number }) => ["session-events", a.id, a.read],
  fetch: (a, context) => api.session.event.list({ id: a.id }, context),
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
