import { Layer } from "effect";

import { currentLocale, type Locale, t } from "@vibevalley/i18n";
import {
  type CommitCount,
  type Conflict,
  type Cron,
  type CronView,
  type Doing,
  type DoingView,
  type FarmView,
  type GameEffect,
  type InboxItem,
  type Issue,
  type MentionedMessage,
  type Progress,
  type Session,
  type SessionPlay,
  type SpaceState,
  type SpaceView,
  type StateFrame,
} from "@vibevalley/protocol";
import { phaseWords } from "@vibevalley/protocol/rules";

import { Projection } from "#/core/core.ts";
import { nextText, whenText } from "#/cron/when.ts";
import { effectsOf, viewOf } from "#/game/view.ts";
import { inbox } from "#/inbox/items.ts";

import { reduce } from "./reduce.ts";

// The core state's projection, given to the core at assembly.
export const layer = Layer.succeed(Projection, { reduce, effects: effectsOf, frame: frameOf });

let cronsMemo: { crons: readonly Cron[]; locale: Locale; out: CronView[] } | undefined;
function projectedCrons(crons: readonly Cron[], locale: Locale): CronView[] {
  if (cronsMemo && cronsMemo.crons === crons && cronsMemo.locale === locale) return cronsMemo.out;
  const out = crons.map((s) => ({ ...s, whenText: whenText(s.when, s.tz), nextText: nextText(s) }));
  cronsMemo = { crons, locale, out };
  return out;
}

let inboxMemo:
  | {
      sessions: readonly Session[];
      issues: readonly Issue[];
      crons: readonly Cron[];
      channels: readonly unknown[] | undefined;
      mentions: readonly MentionedMessage[] | undefined;
      locale: Locale;
      out: InboxItem[];
    }
  | undefined;
function projectedInbox(state: SpaceState, locale: Locale): InboxItem[] {
  const channels = state.chat?.channels;
  const mentions = state.chat?.userMentions;
  if (
    inboxMemo &&
    inboxMemo.sessions === state.sessions &&
    inboxMemo.issues === state.issues &&
    inboxMemo.crons === state.crons &&
    inboxMemo.channels === channels &&
    inboxMemo.mentions === mentions &&
    inboxMemo.locale === locale
  )
    return inboxMemo.out;
  const out = inbox(state);
  inboxMemo = { sessions: state.sessions, issues: state.issues, crons: state.crons, channels, mentions, locale, out };
  return out;
}

let viewMemo:
  | {
      sessions: readonly Session[];
      issues: readonly Issue[];
      plays: Readonly<Record<string, SessionPlay>> | undefined;
      commits: CommitCount | undefined;
      progress: Progress | undefined;
      locale: Locale;
      out: FarmView;
    }
  | undefined;
function projectedView(state: SpaceState, locale: Locale): FarmView {
  if (
    viewMemo &&
    viewMemo.sessions === state.sessions &&
    viewMemo.issues === state.issues &&
    viewMemo.plays === state.plays &&
    viewMemo.commits === state.commits &&
    viewMemo.progress === state.progress &&
    viewMemo.locale === locale
  )
    return viewMemo.out;
  const out = viewOf(state);
  viewMemo = {
    sessions: state.sessions,
    issues: state.issues,
    plays: state.plays,
    commits: state.commits,
    progress: state.progress,
    locale,
    out,
  };
  return out;
}

export function frameOf(state: SpaceState, effects: GameEffect[] = [], seq = 0): StateFrame {
  const locale = currentLocale();
  return { seq, state: withWords(state, locale), inbox: projectedInbox(state, locale), view: projectedView(state, locale), effects };
}

function withWords(state: SpaceState, locale: Locale): SpaceView {
  const doing = (d: Doing): DoingView => ({ ...d, actionText: t(`shared.action.${d.action}`) });
  const conflicts = new Map<string, Conflict | undefined>();
  for (const issue of state.issues) conflicts.set(issue.id, issue.conflict);
  const { plays: _plays, ...rest } = state;
  return {
    ...rest,
    sessions: state.sessions.map(({ phase, ...h }) => ({
      ...h,
      phase: phase._tag === "working" ? { ...phase, doing: doing(phase.doing) } : phase,
      phaseText: phaseWords({ ...h, phase }, h.issue === undefined ? undefined : conflicts.get(h.issue)),
    })),
    crons: projectedCrons(state.crons, locale),
  };
}
