import type { WorkspaceState, Issue, IssueAct, IssueAttention, Session } from "@vibevalley/protocol";
import { sessionOf } from "../session/state.ts";

/** session is the issue's newest one, undefined while none is on the farm. A task graph's issues stand with the graph: the owner acts on them there. */
export function attentionOf(t: Issue, session: Session | undefined): IssueAttention {
  const followed = t.graph !== undefined || t.task !== undefined || t.parent !== undefined || session?.graph !== undefined;
  const own = (s: IssueAttention): IssueAttention => (followed ? { state: s.state, ...at(s.since), ...(s.stuck ? { stuck: s.stuck } : {}), acts: [] } : s);
  const last = session?.lastRun;
  // Completing follows what the issue delivers, not who did the work: an answer is taken (知道了), a change completed (merged, or kept).
  const finish: IssueAct = t.deliver === "answer" ? "acknowledge" : "complete";
  const keep: IssueAct[] = t.deliver === "answer" ? [] : ["keep"];
  switch (t.status) {
    case "done":
      return own({ state: "done", ...at(t.closedAt), acts: t.delivered === "merged_into_parent" ? [] : ["reopen"] });
    case "canceled":
      return own({ state: "canceled", ...at(t.closedAt), lead: "reopen", acts: ["reopen"] });
    case "backlog":
      if (t.task?.state === "waiting") return own({ state: "queued", since: t.createdAt, acts: [] });
      return own(
        t.refining ? { state: "draft", since: t.createdAt, acts: [] } : { state: "draft", since: t.createdAt, lead: "start", acts: ["start", "close"] },
      );
    case "todo":
      return own({ state: "queued", since: t.queuedAt ?? t.createdAt, acts: ["close"] });
    case "in_progress": {
      // Run by no session on the farm: nobody to tell or stop from here; it can still be closed.
      if (!session && t.lastRun) return own({ state: "working", ...at(t.lastRun.startedAt), acts: ["close"] });
      const phase = session?.phase;
      if (phase?._tag === "working" && phase.quietSince !== undefined)
        return own({ state: "stuck", stuck: "quiet", since: phase.quietSince, lead: "stop", acts: ["stop", "tell", "close"] });
      return own({ state: "working", ...at(phase?._tag === "working" ? phase.since : undefined), acts: ["tell", "stop", "close"] });
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
        if (ended === "failed") return { state: "stuck", stuck: "failed", ...done, lead: "close", acts: ["close"] };
        return ended === "interrupted"
          ? { state: "stuck", stuck: "interrupted", ...done, lead: finish, acts: [finish, ...keep, "close"] }
          : { state: "reviewing", ...done, lead: finish, acts: [finish, ...keep, "close"] };
      }
      const since = last?.at;
      if (session?.conflict) return { state: "stuck", stuck: "conflict", ...at(since), lead: "resolve", acts: ["resolve", "tell", "close"] };
      if (t.questions.length > 0) return { state: "asking", ...at(since), lead: "answer", acts: ["answer", "close"] };
      // An answer issue's round that handed back no answer it could read did not get it done either.
      const unread = t.deliver === "answer" && last?.outcome === "completed" && last.answer === undefined;
      if (last?.outcome === "failed" || unread) return { state: "stuck", stuck: "failed", ...at(since), lead: "cure", acts: ["cure", "tell", "close"] };
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be completed.
      if (last?.outcome === "interrupted")
        return { state: "stuck", stuck: "interrupted", ...at(since), lead: "resume", acts: ["resume", finish, ...keep, "tell", "close"] };
      // A required acceptance passes before completing (the server's statusMove); a glance one is passed by completing.
      // Keep is the same completion with the branch left unmerged.
      const lead: IssueAct = t.review === "required" && t.reviewedAt === undefined ? "accept" : finish;
      const acts: IssueAct[] =
        lead === finish
          ? [finish, ...keep, ...(t.reviewedAt === undefined ? (["reject"] as const) : []), "tell", "close"]
          : ["accept", "reject", "tell", "close"];
      return { state: "reviewing", ...at(since), lead, acts };
    }
  }
}

const at = (since: number | undefined) => (since !== undefined ? { since } : {});

export function attentionIn(t: Issue, state: WorkspaceState): IssueAttention {
  const last = t.sessions.at(-1);
  return attentionOf(t, last === undefined ? undefined : sessionOf(state, last));
}
