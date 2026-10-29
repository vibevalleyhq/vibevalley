// The farm's core state, in motion: reduce folds one fact into the state with each module's rules; the recorded runs of
// facts (core/testdata/reduce.jsonl.gz) hold it to the same answers. It never changes what it is given.

import type { WorkspaceState, Fact, OrchestratorState, Outcome, Phase, Session } from "@vibevalley/protocol";
import { withChannel, withMessage, withOwnerMentions } from "@/channel/state.ts";
import { withIssue, withIssueStatuses } from "@/issue/state.ts";
import { farmOf, omitUndefined, same } from "@vibevalley/protocol/rules";
import { freeStation, playedDoing, playedRun, playOf, stationed } from "@/game/play.ts";
import { sessionOf, whileWorking, withSession } from "@/session/state.ts";

const ended = (outcome: Outcome): Phase => (outcome === "completed" ? { _tag: "done" } : outcome === "failed" ? { _tag: "failed" } : { _tag: "resting" });

/** A fact that changes nothing says so (false), and is not sent; facts about sessions not on the farm change nothing. The issues' statuses follow whatever changed. */
export function reduce(state: WorkspaceState, fact: Fact): [WorkspaceState, boolean] {
  const [next, changed] = fold(state, fact);
  return changed && next.issues.length > 0 ? [withIssueStatuses(next), true] : [next, changed];
}

function fold(state: WorkspaceState, f: Fact): [WorkspaceState, boolean] {
  switch (f.type) {
    case "call": {
      if (state.call === f.state && state.callReason === f.reason) return [state, false];
      return [{ ...state, call: f.state, callReason: f.reason }, true];
    }
    case "orchestrator": {
      const was = state.orchestrators[f.agent];
      if ((was?.state ?? "idle") === f.state && was?.channel === f.channel) return [state, false];
      // At rest it leaves the map: idle is what an orchestrator not in it is.
      const { [f.agent]: _was, ...others } = state.orchestrators;
      // A round runs from its first thinking through its writing: its start stays while it goes on.
      const busy = (s: OrchestratorState | undefined) => s === "thinking" || s === "speaking";
      const since = busy(f.state) ? (busy(was?.state) ? was.since : f.at) : undefined;
      const now =
        f.state === "idle" && !f.channel
          ? others
          : { ...others, [f.agent]: { state: f.state, ...(f.channel ? { channel: f.channel } : {}), ...(since !== undefined ? { since } : {}) } };
      return [{ ...state, orchestrators: now }, true];
    }
    case "message": {
      const [chat, news] = withMessage(state.chat, f.message);
      return [chat === state.chat ? state : { ...state, ...(chat ? { chat } : {}) }, news];
    }
    case "channel":
      if (state.chat?.channels.some((c) => c.id === f.channel.id && same(c, f.channel))) return [state, false];
      return [{ ...state, chat: withChannel(state.chat, f.channel) }, true];
    case "channelGone": {
      const all = state.chat?.channels ?? [];
      const kept = all.filter((c) => c.id !== f.id && c.parent !== f.id);
      return kept.length === all.length || !state.chat ? [state, false] : [{ ...state, chat: { ...state.chat, channels: kept } }, true];
    }
    case "ownerMentions":
      return same(state.chat?.ownerMentions, f.mentions) ? [state, false] : [{ ...state, chat: withOwnerMentions(state.chat, f.mentions) }, true];
    case "hired": {
      const others = state.sessions.filter((h) => h.id !== f.session.id);
      const was = sessionOf(state, f.session.id);
      const play = was?.play ?? { ...playOf(f.session), station: freeStation(others, farmOf(f.session)) };
      const h: Session = { ...f.session, play };
      return [{ ...state, sessions: [...others, h] }, true];
    }
    case "station":
      return stationed(state, f);
    case "run":
      return withSession(state, f.id, (h) => ({
        ...h,
        brief: f.brief ? f.brief : h.brief,
        phase: { _tag: "working", since: f.at, doing: { action: "thinking", label: "" } },
        play: playedRun(playOf(h), f.at),
      }));
    case "doing": {
      const [after, changed] = whileWorking(state, f.id, (p) => ({ _tag: "working", since: p.since, doing: { action: f.action, label: f.label } }));
      if (!changed) return [state, false];
      return withSession(after, f.id, (h) => ({ ...h, play: playedDoing(playOf(h), f) }));
    }
    case "quiet":
      return whileWorking(state, f.id, (p) => ({ ...p, quietSince: f.since }));
    case "retry":
      return whileWorking(state, f.id, (p) => ({ ...p, retry: f.of ? { attempt: f.attempt, of: f.of } : { attempt: f.attempt } }));
    case "spent":
      return withSession(state, f.id, (h) => ({ ...h, spent: f.spent }));
    case "report":
      if (!sessionOf(state, f.id)) return [state, false];
      return [
        withSession(state, f.id, (x) => ({
          ...x,
          runs: f.runs,
          phase: ended(f.outcome),
          lastRun: omitUndefined({ outcome: f.outcome, summary: f.summary, at: f.at, spent: f.spent, answer: f.answer }),
        }))[0],
        true,
      ];
    case "conflict":
      return withSession(state, f.id, (h) => omitUndefined({ ...h, conflict: f.conflict }));
    case "left":
      return [{ ...state, sessions: state.sessions.filter((h) => h.id !== f.id) }, true];
    case "commits":
      if (state.commits && same(state.commits, f.commits)) return [state, false];
      return [{ ...state, commits: f.commits }, true];
    case "progress":
      if (state.progress && same(state.progress, f.progress)) return [state, false];
      return [{ ...state, progress: f.progress }, true];
    case "cron": {
      const all = [...state.crons];
      const i = all.findIndex((x) => x.id === f.cron.id);
      if (i >= 0 && same(all[i], f.cron)) return [state, false];
      if (i >= 0) all[i] = f.cron;
      else all.push(f.cron);
      return [{ ...state, crons: all }, true];
    }
    case "cronGone":
      if (!state.crons.some((x) => x.id === f.id)) return [state, false];
      return [{ ...state, crons: state.crons.filter((x) => x.id !== f.id) }, true];
    case "issue":
      if (state.issues.some((t) => t.id === f.issue.id && same(t, f.issue))) return [state, false];
      return [{ ...state, issues: withIssue(state.issues, f.issue) }, true];
    case "issueGone":
      if (!state.issues.some((x) => x.id === f.id)) return [state, false];
      return [{ ...state, issues: state.issues.filter((x) => x.id !== f.id) }, true];
    case "connector": {
      const all = [...state.connectors];
      const i = all.findIndex((x) => x.id === f.status.id);
      if (i >= 0 && same(all[i], f.status)) return [state, false];
      if (i >= 0) all[i] = f.status;
      else all.push(f.status);
      return [{ ...state, connectors: all }, true];
    }
  }
}
