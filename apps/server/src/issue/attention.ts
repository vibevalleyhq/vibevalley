import type { ActWords, WorkspaceState, Issue, IssueAct, IssueAction, IssueAttention, IssueStatus, Session } from "@vibevalley/protocol";

import { sessionOf } from "@/session/roster.ts";
const move = (act: IssueAct, status: IssueStatus, words: ActWords = "none"): IssueAction => ({ act, does: "move", status, words });
const say = (act: IssueAct): IssueAction => ({ act, does: "say" });
const stop: IssueAction = { act: "stop", does: "stop" };
const close = move("close", "canceled");

/** session is the issue's newest one, undefined while none is on the farm. A task graph's issues stand with the graph: the owner acts on them there. */
export function attentionOf(t: Issue, session: Session | undefined): IssueAttention {
  const followed = t.graph !== undefined || t.task !== undefined || t.parent !== undefined || session?.graph !== undefined;
  const own = (s: IssueAttention): IssueAttention => (followed ? { state: s.state, ...at(s.since), ...(s.stuck ? { stuck: s.stuck } : {}), acts: [] } : s);
  const last = session?.lastRun;
  // A profile's talk asks nothing of the owner: its words are in its channel, and it has no buttons.
  if (t.talk) return { state: session?.phase._tag === "working" ? "working" : "done", acts: [] };
  // Completing follows what the issue delivers, not who did the work: an answer is taken (知道了), a change completed
  // (merged, or kept on its branch).
  const finish = move(t.deliver === "answer" ? "acknowledge" : "complete", "done");
  // Sent before, it is taken up again with what to do this time; never sent, it goes back to the backlog.
  const sent = t.sessions.length > 0 || t.lastRun !== undefined;
  const reopen = sent ? move("reopen", "todo", "required") : move("reopen", "backlog");
  switch (t.status) {
    case "done":
      return own({ state: "done", ...at(t.closedAt), acts: t.delivered === "merged_into_parent" ? [] : [reopen] });
    case "canceled":
      return own({ state: "canceled", ...at(t.closedAt), lead: "reopen", acts: [reopen] });
    case "backlog":
      if (t.task?.state === "waiting") return own({ state: "queued", since: t.createdAt, acts: [] });
      return own(
        t.refining
          ? { state: "draft", since: t.createdAt, acts: [] }
          : { state: "draft", since: t.createdAt, lead: "start", acts: [move("start", "todo"), close] },
      );
    case "todo":
      return own({ state: "queued", since: t.queuedAt ?? t.createdAt, acts: [close] });
    case "in_progress": {
      // Run by no session on the farm: nobody to tell or stop from here; it can still be closed.
      if (!session && t.lastRun) return own({ state: "working", ...at(t.lastRun.startedAt), acts: [close] });
      const phase = session?.phase;
      if (phase?._tag === "working" && phase.quietSince !== undefined)
        return own({ state: "stuck", stuck: "quiet", since: phase.quietSince, lead: "stop", acts: [stop, say("tell"), close] });
      return own({ state: "working", ...at(phase?._tag === "working" ? phase.since : undefined), acts: [say("tell"), stop, close] });
    }
    case "in_review": {
      if (followed)
        return own({
          state: t.task?.state === "failed" ? "stuck" : "reviewing",
          ...(t.task?.state === "failed" ? { stuck: "failed" as const } : {}),
          acts: [],
        });
      // Run by no session on the farm (an in-process agent's): its latest run says how it ended. A failed one cannot be taken
      // as done; another round is the issue moved back to todo.
      if (!session && t.lastRun) {
        const ended = t.lastRun.outcome ?? "completed";
        const done = at(t.lastRun.endedAt);
        if (ended === "failed") return { state: "stuck", stuck: "failed", ...done, lead: "close", acts: [close] };
        return ended === "interrupted"
          ? { state: "stuck", stuck: "interrupted", ...done, lead: finish.act, acts: [finish, close] }
          : { state: "reviewing", ...done, lead: finish.act, acts: [finish, close] };
      }
      const since = last?.at;
      // Stuck, moving it back to todo with no words is the server's own for why: settle the conflict, mend, go on.
      if (session?.conflict) return { state: "stuck", stuck: "conflict", ...at(since), lead: "resolve", acts: [move("resolve", "todo"), say("tell"), close] };
      if (t.questions.length > 0) return { state: "asking", ...at(since), lead: "answer", acts: [say("answer"), close] };
      // An answer issue's round that handed back no answer it could read did not get it done either.
      const unread = t.deliver === "answer" && last?.outcome === "completed" && last.answer === undefined;
      if (last?.outcome === "failed" || unread)
        return { state: "stuck", stuck: "failed", ...at(since), lead: "cure", acts: [move("cure", "todo"), say("tell"), close] };
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be completed.
      if (last?.outcome === "interrupted")
        return { state: "stuck", stuck: "interrupted", ...at(since), lead: "resume", acts: [move("resume", "todo"), finish, say("tell"), close] };
      // Completing is the acceptance. Sending it back takes the findings, unless the orchestrator already passed it.
      const reject: IssueAction[] = t.reviewedAt === undefined ? [move("reject", "todo", "required")] : [];
      return { state: "reviewing", ...at(since), lead: finish.act, acts: [finish, ...reject, say("tell"), close] };
    }
  }
}

const at = (since: number | undefined) => (since !== undefined ? { since } : {});

export function attentionIn(t: Issue, state: WorkspaceState): IssueAttention {
  const last = t.sessions.at(-1);
  return attentionOf(t, last === undefined ? undefined : sessionOf(state, last));
}
