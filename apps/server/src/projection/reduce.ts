// The farm's core state, in motion: reduce folds one fact into the state with each module's rules; the recorded runs of
// facts (core/testdata/reduce.jsonl.gz) hold it to the same answers. It never changes what it is given.
import type * as T from "@vibevalley/protocol";
import { farmOf, omitUndefined, same } from "@vibevalley/protocol/rules";

import { withChannel, withMessage, withOwnerMentions } from "#/channel/messages.ts";
import { emptyPlay, freeStation, playedDoing, playedRun, playOf, stationed } from "#/game/view.ts";
import { withIssue, withIssueStatuses } from "#/issue/status.ts";
import { sessionOf, withSession } from "#/session/roster.ts";

const ended = (outcome: T.Outcome): T.Phase => (outcome === "completed" ? { _tag: "done" } : outcome === "failed" ? { _tag: "failed" } : { _tag: "resting" });

/** A fact that changes nothing says so (false), and is not sent; facts about sessions not on the farm change nothing. The issues' statuses follow whatever changed. */
export function reduce(state: T.WorkspaceState, fact: T.Fact): [T.WorkspaceState, boolean] {
  const [next, changed] = fold(state, fact);
  return changed && (next.issues !== state.issues || next.sessions !== state.sessions) ? [withIssueStatuses(next), true] : [next, changed];
}

function fold(state: T.WorkspaceState, f: T.Fact): [T.WorkspaceState, boolean] {
  switch (f.type) {
    case "callChanged": {
      if (state.call === f.state && state.callReason === f.reason) return [state, false];
      return [{ ...state, call: f.state, callReason: f.reason }, true];
    }
    case "sessionPhaseChanged": {
      const session = sessionOf(state, f.id);
      if (
        !session ||
        (same(session.phase, f.phase) &&
          session.channel === f.channel &&
          (f.spent === undefined || same(session.spent, f.spent)) &&
          (f.brief === undefined || f.brief === session.brief))
      )
        return [state, false];
      const [after] = withSession(state, f.id, (h) =>
        omitUndefined({
          ...h,
          phase: f.phase,
          channel: f.channel,
          brief: f.brief ?? h.brief,
          ...(f.spent ? { spent: f.spent } : {}),
        }),
      );
      const plays = state.plays ?? {};
      const before = playOf(plays, f.id);
      const play =
        f.phase._tag === "working"
          ? session.phase._tag === "working"
            ? playedDoing(before, { at: f.at, action: f.phase.doing.action, label: f.phase.doing.label })
            : playedRun(before, f.at)
          : before;
      return [{ ...after, plays: { ...plays, [f.id]: play } }, true];
    }
    case "messageChanged": {
      const [chat, news] = withMessage(state.chat, f.message);
      return [chat === state.chat ? state : { ...state, ...(chat ? { chat } : {}) }, news];
    }
    case "channelChanged":
      if (state.chat?.channels.some((c) => c.id === f.channel.id && same(c, f.channel)) === true) return [state, false];
      return [{ ...state, chat: withChannel(state.chat, f.channel) }, true];
    case "channelRemoved": {
      const all = state.chat?.channels ?? [];
      const kept = all.filter((c) => c.id !== f.id && c.parent !== f.id);
      return kept.length === all.length || !state.chat ? [state, false] : [{ ...state, chat: { ...state.chat, channels: kept } }, true];
    }
    case "ownerMentionsChanged":
      return same(state.chat?.ownerMentions, f.mentions) ? [state, false] : [{ ...state, chat: withOwnerMentions(state.chat, f.mentions) }, true];
    case "sessionChanged": {
      const others = state.sessions.filter((h) => h.id !== f.session.id);
      const was = sessionOf(state, f.session.id);
      if (f.session.role === "orchestrator") return [{ ...state, sessions: [...others, f.session] }, true];
      const plays = state.plays ?? {};
      const play = was ? playOf(plays, f.session.id) : { ...emptyPlay(), station: freeStation(plays, others, farmOf(f.session)) };
      return [{ ...state, sessions: [...others, f.session], plays: { ...plays, [f.session.id]: play } }, true];
    }
    case "sessionReported":
      if (!sessionOf(state, f.id)) return [state, false];
      return [
        withSession(state, f.id, (x) => ({
          ...x,
          runs: f.runs,
          phase:
            f.outcome === "completed" &&
            f.phase?._tag === "resting" &&
            x.issue !== undefined &&
            state.issues.some((issue) => issue.id === x.issue && issue.pullRequest?.state === "open")
              ? f.phase
              : ended(f.outcome),
          lastRun: omitUndefined({ outcome: f.outcome, summary: f.summary, at: f.at, spent: f.spent, answer: f.answer }),
        }))[0],
        true,
      ];
    case "sessionLeft": {
      const plays = { ...state.plays };
      delete plays[f.id];
      return [{ ...state, sessions: state.sessions.filter((h) => h.id !== f.id), plays }, true];
    }
    case "progressChanged": {
      let next = state;
      let changed = false;
      if (f.commits !== undefined && !same(next.commits, f.commits)) {
        next = { ...next, commits: f.commits };
        changed = true;
      }
      if (f.progress !== undefined && !same(next.progress, f.progress)) {
        next = { ...next, progress: f.progress };
        changed = true;
      }
      if (f.station !== undefined) {
        const [stationedState, moved] = stationed(next, f.station);
        if (moved) {
          next = stationedState;
          changed = true;
        }
      }
      return [next, changed];
    }
    case "cronChanged": {
      const all = [...state.crons];
      const i = all.findIndex((x) => x.id === f.cron.id);
      if (i >= 0 && same(all[i], f.cron)) return [state, false];
      if (i >= 0) all[i] = f.cron;
      else all.push(f.cron);
      return [{ ...state, crons: all }, true];
    }
    case "cronRemoved":
      if (!state.crons.some((x) => x.id === f.id)) return [state, false];
      return [{ ...state, crons: state.crons.filter((x) => x.id !== f.id) }, true];
    case "issueChanged":
      if (state.issues.some((t) => t.id === f.issue.id && same(t, f.issue))) return [state, false];
      return [{ ...state, issues: withIssue(state.issues, f.issue) }, true];
    case "issueRemoved":
      if (!state.issues.some((x) => x.id === f.id)) return [state, false];
      return [{ ...state, issues: state.issues.filter((x) => x.id !== f.id) }, true];
    case "connectorChanged": {
      const all = [...state.connectors];
      const i = all.findIndex((x) => x.id === f.status.id);
      if (i >= 0 && same(all[i], f.status)) return [state, false];
      if (i >= 0) all[i] = f.status;
      else all.push(f.status);
      return [{ ...state, connectors: all }, true];
    }
  }
}
