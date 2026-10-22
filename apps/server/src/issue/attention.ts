// Where an issue stands for the owner: one state out of the issue's status, its session's phase, the questions, a
// conflict and the acceptance, with the one thing the owner is asked to do. The board, the farm and the page all say it.

import type { WorkspaceState, Issue, IssueAct, IssueAttention, Session } from "@vibevalley/protocol";
import { isForAssistant } from "./state.ts";
import { sessionOf } from "../session/state.ts";

/** session is the issue's newest one, when it is on the farm. A task graph's issues and one for the assistant go with the
 * graph or the assistant: they stand, but the owner acts on them elsewhere. */
export function attentionOf(t: Issue, session: Session | undefined): IssueAttention {
  const followed = t.graph !== undefined || t.task !== undefined || t.parent !== undefined || session?.graph !== undefined || isForAssistant(t);
  const own = (s: IssueAttention): IssueAttention => (followed ? { state: s.state, ...at(s.since), ...(s.stuck ? { stuck: s.stuck } : {}), acts: [] } : s);
  const last = session?.lastRun;
  switch (t.status) {
    case "done":
      return own({ state: "harvested", ...at(t.closedAt), acts: t.closed === "merged_into_graph" ? [] : ["reopen"] });
    case "canceled":
      return own({ state: "closed", ...at(t.closedAt), lead: "reopen", acts: ["reopen"] });
    case "backlog":
      if (t.task?.state === "waiting") return own({ state: "queued", since: t.createdAt, acts: [] });
      return own(
        t.refining ? { state: "draft", since: t.createdAt, acts: [] } : { state: "draft", since: t.createdAt, lead: "start", acts: ["start", "close"] },
      );
    case "todo":
      return own({ state: "queued", since: t.queuedAt ?? t.createdAt, acts: ["close"] });
    case "in_progress": {
      const phase = session?.phase;
      if (phase?._tag === "working" && phase.quietSince !== undefined)
        return own({ state: "stuck", stuck: "quiet", since: phase.quietSince, lead: "stop", acts: ["stop", "tell", "close"] });
      return own({ state: "working", ...at(phase?._tag === "working" ? phase.since : undefined), acts: ["tell", "stop", "close"] });
    }
    case "in_review": {
      // The assistant's turn ended: what it said is the owner's to take (acknowledge) or put away; one that did not end well
      // cannot be taken as done.
      if (isForAssistant(t)) {
        const ended = t.handedBack?.outcome ?? "completed";
        const since = at(t.handedBack?.at);
        return ended === "completed"
          ? { state: "reviewing", ...since, lead: "acknowledge", acts: ["acknowledge", "close"] }
          : { state: "stuck", stuck: ended, ...since, lead: "close", acts: ["close"] };
      }
      if (followed)
        return own({
          state: t.task?.state === "failed" ? "stuck" : "reviewing",
          ...(t.task?.state === "failed" ? { stuck: "failed" as const } : {}),
          acts: [],
        });
      const since = last?.at;
      if (session?.conflict) return { state: "stuck", stuck: "conflict", ...at(since), lead: "resolve", acts: ["resolve", "tell", "close"] };
      if (t.questions.length > 0) return { state: "asking", ...at(since), lead: "answer", acts: ["answer", "close"] };
      if (last?.outcome === "failed") return { state: "stuck", stuck: "failed", ...at(since), lead: "cure", acts: ["cure", "tell", "close"] };
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be harvested.
      if (last?.outcome === "interrupted")
        return { state: "stuck", stuck: "interrupted", ...at(since), lead: "resume", acts: ["resume", "harvest", "tell", "close"] };
      // A required acceptance passes before the harvest (the server's statusMove); a glance one is passed by the harvest.
      const lead: IssueAct = t.review === "required" && t.reviewedAt === undefined ? "accept" : "harvest";
      const acts: IssueAct[] =
        lead === "harvest" ? ["harvest", ...(t.reviewedAt === undefined ? (["reject"] as const) : []), "tell", "close"] : ["accept", "reject", "tell", "close"];
      return { state: "reviewing", ...at(since), lead, acts };
    }
  }
}

const at = (since: number | undefined) => (since !== undefined ? { since } : {});

/** The issue's attention with its newest session as the state has it. */
export function attentionIn(t: Issue, state: WorkspaceState): IssueAttention {
  const last = t.sessions.at(-1);
  return attentionOf(t, last === undefined ? undefined : sessionOf(state, last));
}
