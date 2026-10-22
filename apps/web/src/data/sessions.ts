// A session's log as the views read it: the issue pages (workbench and farm), the trajectory and the work log.

import { type Accessor, createMemo, createSignal, onSettled } from "solid-js";
import type { SessionEvent } from "@vibevalley/protocol";
import { mergeSteps } from "../rules/rounds";
import { api } from "./api";
import { subscribeLive } from "./live";
import { ready, useQuery } from "./query";

/** A session's log (the orchestrator's is "orchestrator"): the read one, with what the live stream brought since merged in by seq. */
export function createSessionEvents(id: Accessor<string>, enabled: Accessor<boolean>): Accessor<SessionEvent[]> {
  const read = useQuery(() => ({ queryKey: ["session-events", id()], queryFn: () => api.session.events({ id: id() }), enabled: enabled() }));
  const [arrived, setArrived] = createSignal<SessionEvent[]>([]);
  onSettled(() =>
    subscribeLive((e) => {
      if (enabled() && e.type === "event" && e.id === id()) setArrived((a) => mergeSteps(a, [e.activity]));
    }),
  );
  return createMemo(() => mergeSteps(ready(read, []), arrived()));
}
