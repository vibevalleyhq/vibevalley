import { Effect, Equal, Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { sessionIdsOf, stageWantsUser } from "@vibevalley/protocol/rules";

import { bounded, type Core } from "#/core/core.ts";
import type { Session } from "#/modules/session/session.ts";

export const watchIssue = (
  initial: T.Issue,
  core: Pick<Core["Service"], "subscribe" | "states">,
  sessions: Pick<Session["Service"], "events">,
): Stream.Stream<T.IssueWatch> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* core.subscribe;
      const queue = yield* Stream.toQueue(bounded(live, "issue.watch"), { capacity: 1 });
      let ids = new Set<T.SessionId>(sessionIdsOf(initial).slice(-8));
      let loaded = false;
      let wasSettled = false;
      let previous: T.IssueWatch | undefined;
      const snapshots = core.states.pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (frame) {
            const issue = frame.state.issues.find((i) => i.id === initial.id) ?? (initial.closedAt !== undefined ? initial : undefined);
            if (!issue) return [{ kind: "missing", issue: initial.id } satisfies T.IssueWatch];
            const all = sessionIdsOf(issue);
            const selected = all.slice(-8);
            const settled = stageWantsUser(issue.stage.state) || issue.stage.state === "done" || issue.stage.state === "canceled";
            const state: T.IssueWatch = {
              kind: "state",
              issue,
              sessionIds: selected,
              sessions: frame.state.sessions.filter((s) => selected.includes(s.id)),
              settled,
              omittedSessions: Math.max(0, all.length - selected.length),
            };
            if (previous !== undefined && Equal.equals(state, previous)) return [];
            previous = state;
            const rows: T.IssueWatch[] = [];
            for (const id of selected) {
              if (loaded && ids.has(id) && !(settled && !wasSettled)) continue;
              const history = ((yield* sessions.events(id)) ?? []).slice(-241);
              const first = history[0]?.seq;
              if (first !== undefined && first > 0) rows.push({ kind: "gap", session: id, before: first });
              if (first === undefined && !frame.state.sessions.some((s) => s.id === id)) rows.push({ kind: "gap", session: id });
              rows.push({ kind: "history", session: id, events: history });
            }
            ids = new Set(selected);
            loaded = true;
            wasSettled = settled;
            rows.push(state);
            return rows;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
      );
      const events = Stream.fromQueue(queue).pipe(
        Stream.filter((e): e is Extract<T.LiveEvent, { type: "event" }> => e.type === "event"),
        Stream.filter((e) => ids.has(e.id)),
        Stream.map((e): T.IssueWatch => ({ kind: "event", session: e.id, event: e.activity })),
      );
      return Stream.merge(snapshots, events, { haltStrategy: "either" });
    }),
  );
