import { currentLocale, type Locale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { phaseWords } from "@vibevalley/protocol/rules";

import type { Projection } from "#/core/core.ts";
import { effectsOf, viewOf } from "#/modules/game/view.ts";
import { inbox } from "#/modules/inbox/items.ts";
import { nextText, whenText } from "#/modules/issue/when.ts";

import { reduce } from "./reduce.ts";

/** Builds an isolated frame projector whose single-slot caches belong to one `Core` instance. */
export function makeFrameOf(): (state: T.SpaceState, effects?: T.GameEffect[], seq?: number) => T.StateFrame {
  let cronsMemo: { crons: readonly T.Cron[]; locale: Locale; out: T.CronView[] } | undefined;
  const projectedCrons = (crons: readonly T.Cron[], locale: Locale): T.CronView[] => {
    if (cronsMemo && cronsMemo.crons === crons && cronsMemo.locale === locale) return cronsMemo.out;
    const out = crons.map((s) => ({ ...s, whenText: whenText(s.when, s.tz), nextText: nextText(s) }));
    cronsMemo = { crons, locale, out };
    return out;
  };

  let inboxMemo:
    | {
        sessions: readonly T.Session[];
        issues: readonly T.Issue[];
        crons: readonly T.Cron[];
        channels: readonly unknown[] | undefined;
        mentions: NonNullable<T.SpaceState["chat"]>["userMentions"] | undefined;
        locale: Locale;
        out: T.InboxItem[];
      }
    | undefined;
  const projectedInbox = (state: T.SpaceState, locale: Locale): T.InboxItem[] => {
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
  };

  let viewMemo:
    | {
        sessions: readonly T.Session[];
        issues: readonly T.Issue[];
        plays: Readonly<Record<string, T.SessionPlay>> | undefined;
        commits: T.CommitCount | undefined;
        progress: T.Progress | undefined;
        locale: Locale;
        out: T.FarmView;
      }
    | undefined;
  const projectedView = (state: T.SpaceState, locale: Locale): T.FarmView => {
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
  };

  const withWords = (state: T.SpaceState, locale: Locale): T.SpaceView => {
    const doing = (d: T.Doing): T.DoingView => ({ ...d, actionText: t(`shared.action.${d.action}`) });
    const conflicts = new Map<string, T.Conflict | undefined>();
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
  };

  return (state: T.SpaceState, effects: T.GameEffect[] = [], seq = 0): T.StateFrame => {
    const locale = currentLocale();
    return { seq, state: withWords(state, locale), inbox: projectedInbox(state, locale), view: projectedView(state, locale), effects };
  };
}

// Each Core gets its own Projection so concurrent farms never thrash or share memo slots.
export const makeProjection = (): Projection => ({ reduce, effects: effectsOf, frame: makeFrameOf() });

export function frameOf(state: T.SpaceState, effects: T.GameEffect[] = [], seq = 0): T.StateFrame {
  return makeFrameOf()(state, effects, seq);
}
