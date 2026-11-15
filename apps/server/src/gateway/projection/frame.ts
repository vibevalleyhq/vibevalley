import { currentLocale, type Locale, setLocale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { issueScopeOf } from "@vibevalley/protocol/rules";

import type { CommitCount, Projection } from "#/core/core.ts";
import { nextText, whenText } from "#/modules/cron/when.ts";
import { effectsOf, reducePlay, type SessionPlay, viewOf } from "#/modules/game/view.ts";
import { phaseWords } from "#/modules/session/report.ts";
import type { Doing } from "#/modules/session/shapes.ts";
import { inbox } from "#/modules/watch/items.ts";

import { reduce } from "./reduce.ts";

const emptyPlays: Readonly<Record<string, SessionPlay>> = {};

const inLocale = <A>(locale: Locale, run: () => A): A => {
  const was = currentLocale();
  if (was === locale) return run();
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale(was);
  }
};

/** Builds an isolated frame projector whose single-slot caches belong to one `Core` instance. */
export function makeFrameOf(
  playsOf: () => Readonly<Record<string, SessionPlay>> = () => emptyPlays,
  localeOf: () => Locale = currentLocale,
): (state: T.SpaceState, effects?: T.GameEffect[], seq?: number) => T.StateFrame {
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
        plays: Readonly<Record<string, SessionPlay>>;
        commits: CommitCount | undefined;
        progress: T.Progress | undefined;
        locale: Locale;
        out: T.FarmView;
      }
    | undefined;
  const projectedView = (state: T.SpaceState, locale: Locale): T.FarmView => {
    const plays = playsOf();
    if (
      viewMemo &&
      viewMemo.sessions === state.sessions &&
      viewMemo.issues === state.issues &&
      viewMemo.plays === plays &&
      viewMemo.commits === state.commits &&
      viewMemo.progress === state.progress &&
      viewMemo.locale === locale
    )
      return viewMemo.out;
    const out = viewOf(state, plays);
    viewMemo = {
      sessions: state.sessions,
      issues: state.issues,
      plays,
      commits: state.commits,
      progress: state.progress,
      locale,
      out,
    };
    return out;
  };

  const withWords = (state: T.SpaceState, locale: Locale): T.SpaceView => {
    const doing = (d: Doing): T.DoingView => ({ ...d, actionText: t(`shared.action.${d.action}`) });
    const conflicts = new Map<string, T.Issue["conflict"]>();
    for (const issue of state.issues) conflicts.set(issue.id, issue.conflict);
    return {
      ...state,
      sessions: state.sessions.map(({ phase, ...h }) => {
        const issue = issueScopeOf(h);
        return {
          ...h,
          phase: phase._tag === "working" ? { ...phase, doing: doing(phase.doing) } : phase,
          phaseText: phaseWords({ ...h, phase }, issue ? conflicts.get(issue) : undefined),
        };
      }),
      crons: projectedCrons(state.crons, locale),
    };
  };

  return (state: T.SpaceState, effects: T.GameEffect[] = [], seq = 0): T.StateFrame => {
    const locale = localeOf();
    return inLocale(locale, () => ({
      seq,
      state: withWords(state, locale),
      inbox: projectedInbox(state, locale),
      view: projectedView(state, locale),
      effects,
    }));
  };
}

export interface ProjectionOptions {
  readonly locale?: () => Locale;
}

// Each Core gets its own Projection so concurrent farms never thrash or share memo slots.
export function makeProjection(options: ProjectionOptions = {}): Projection {
  const localeOf = options.locale ?? currentLocale;
  let plays: Readonly<Record<string, SessionPlay>> = {};
  const frame = makeFrameOf(() => plays, localeOf);
  return {
    reduce: (state, fact) => {
      const [next, stateChanged] = reduce(state, fact);
      const [nextPlays, playChanged] = reducePlay(plays, state, fact);
      plays = nextPlays;
      return [next, stateChanged || playChanged];
    },
    effects: (before, fact) => inLocale(localeOf(), () => effectsOf(before, fact)),
    frame,
  };
}

export function frameOf(state: T.SpaceState, effects: T.GameEffect[] = [], seq = 0): T.StateFrame {
  return makeFrameOf()(state, effects, seq);
}
