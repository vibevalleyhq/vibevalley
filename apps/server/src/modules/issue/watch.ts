import { isDeepStrictEqual } from "node:util";

import { anySignal, merge } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { sessionIdsOf, stageWantsUser } from "@vibevalley/protocol/rules";

import { bounded, type Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Session } from "#/modules/session/session.ts";

const ended = Symbol("ended");

/** source, then one `ended` once it has: the watch stops when either of its sources does. */
async function* untilEnd<A>(source: AsyncIterable<A>): AsyncGenerator<A | typeof ended> {
  yield* source;
  yield ended;
}

export async function* watchIssue(
  initial: T.Issue,
  core: Pick<Core, "subscribe" | "states">,
  sessions: Pick<Session, "events">,
  log: Logger,
  signal?: AbortSignal,
): AsyncGenerator<T.IssueWatch> {
  // Subscribed before the first frame is read: an event told while history is read is not missed.
  const live = core.subscribe();
  // Both sources wait on this, so stopping the watch ends a source that waits for its next value.
  const stop = new AbortController();
  const inner = anySignal(stop.signal, signal);
  let ids = new Set<T.SessionId>(sessionIdsOf(initial).slice(-8));
  let loaded = false;
  let wasSettled = false;
  let previous: T.IssueWatch | undefined;

  async function* snapshots(): AsyncGenerator<T.IssueWatch> {
    for await (const frame of core.states(inner)) {
      const issue = frame.state.issues.find((i) => i.id === initial.id) ?? (initial.closedAt !== undefined ? initial : undefined);
      if (!issue) {
        yield { kind: "missing", issue: initial.id };
        continue;
      }
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
      if (previous !== undefined && isDeepStrictEqual(state, previous)) continue;
      previous = state;
      const rows: T.IssueWatch[] = [];
      for (const id of selected) {
        if (loaded && ids.has(id) && !(settled && !wasSettled)) continue;
        const history = ((await sessions.events(id)) ?? []).slice(-241);
        const first = history[0]?.seq;
        if (first !== undefined && first > 0) rows.push({ kind: "gap", session: id, before: first });
        if (first === undefined && !frame.state.sessions.some((s) => s.id === id)) rows.push({ kind: "gap", session: id });
        rows.push({ kind: "history", session: id, events: history });
      }
      ids = new Set(selected);
      loaded = true;
      wasSettled = settled;
      rows.push(state);
      yield* rows;
    }
  }

  async function* events(): AsyncGenerator<T.IssueWatch> {
    for await (const e of bounded(live, "issue.watch", log, 64, inner)) {
      if (e.type === "event" && ids.has(e.id)) yield { kind: "event", session: e.id, event: e.activity };
    }
  }

  const merged = merge(untilEnd(snapshots()), untilEnd(events()))[Symbol.asyncIterator]();
  try {
    for (;;) {
      const r = await merged.next();
      if (r.done === true || r.value === ended) return;
      yield r.value;
    }
  } finally {
    stop.abort();
    live.close();
    await merged.return?.(undefined);
  }
}
