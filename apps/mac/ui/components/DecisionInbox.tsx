// DecisionInbox: everything that waits on a yes or no from the user, in a
// gray tray with a white card: permission requests, reviews (Complete /
// Send back), merge conflicts, questions. Each open decision has at most
// two quick answers; an answer shows a short confirmation for 1100 ms, then
// the row folds away, the count goes down and the next folded one opens.
// Ported from affectUI's Decision Inbox (free).
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { announce, cleanup, colorScheme, createMotion, effect, reduceMotion, signal, Text, untracked, View } from "nsh";

import { animateLayout, durations, ease, ms } from "../motion";
import { radius, tok, type as ty } from "../tokens";
import { intentOf, type Act, type Action, type AgentEvent, type Frame, type InboxKind, type IssueIntent, type PermissionIntent } from "./shapes";
import { words } from "./words";

export type DecisionKind = InboxKind | "permission";

/** What pressing an answer sends; the host carries it out. */
export type DecisionIntent =
  | ({ type: "issue" } & IssueIntent)
  | ({ type: "permission" } & PermissionIntent)
  /** Needs more than a button (words, a choice of many): open the issue at `act`. */
  | { type: "open"; issue: string; act?: Act }
  | { type: "open_terminal"; session: string };

export type Choice = {
  label: string;
  intent: DecisionIntent;
  /** The confirmation shown once chosen; none: choosing does not settle it (it only opens something). */
  done?: string;
};

export type Decision = {
  id: string;
  kind: DecisionKind;
  title: string;
  /** Who asks (a session's name) and when. */
  source?: string | null;
  atMs: number;
  detail?: string | null;
  primary: Choice;
  secondary?: Choice | null;
};

export type DecisionInboxProps = {
  entries: Decision[];
  onDecide: (entry: Decision, choice: "primary" | "secondary") => void;
  /** How many open at first; the rest start folded to one muted line. */
  openFirst?: number;
};

// ---- Building decisions from the frame and the agents' events ----

function choiceOf(issue: string, a: Action, label: string): Choice {
  // A button that takes the user's words cannot answer from here: it opens the issue there.
  if (a.does === "say" || (a.does === "move" && a.words === "required")) {
    return { label: `${label}…`, intent: { type: "open", issue, act: a.act } };
  }
  return { label, intent: { type: "issue", ...intentOf(issue, a) }, done: words().done[a.act] };
}

/** The frame's inbox as decisions. The buttons are the issue's own actions: the lead first. */
export function decisionsFromFrame(frame: Frame): Decision[] {
  const w = words();
  const out: Decision[] = [];
  for (const item of frame.inbox) {
    const issue = item.issue ? frame.issues.find((t) => t.id === item.issue) : undefined;
    if (!issue) continue;
    const session = item.target.kind === "session" ? frame.sessions.find((s) => s.id === item.target.id) : undefined;
    const acts = issue.stage.acts;
    const lead = acts.find((a) => a.act === issue.stage.lead) ?? acts.find((a) => a.act !== "close");
    let primary: Choice | undefined;
    let secondary: Choice | null = null;
    let detail: string | null = session?.last_run?.summary || item.text || null;

    if (item.kind === "ask") {
      const q = issue.questions[0];
      detail = q?.question ?? detail;
      const answer = acts.find((a) => a.act === "answer");
      const options = q?.options ?? [];
      if (answer && options.length > 0) {
        primary = { label: options[0], intent: { type: "issue", ...intentOf(issue.id, answer, options[0]) }, done: options[0] };
        secondary =
          options.length === 2
            ? { label: options[1], intent: { type: "issue", ...intentOf(issue.id, answer, options[1]) }, done: options[1] }
            : { label: w.answerMore, intent: { type: "open", issue: issue.id, act: "answer" } };
      }
    } else if (item.kind === "conflict") {
      const files = issue.conflict?.files ?? [];
      detail = `${w.conflictFiles(files.length)} (${issue.conflict?.base ?? "main"}): ${files.join(", ")}`;
      if (session) secondary = { label: w.openTerminal, intent: { type: "open_terminal", session: session.id } };
    } else if (item.kind === "quiet" && session?.phase.tag === "working") {
      detail = session.phase.doing || session.brief;
    }

    if (!primary && lead) primary = choiceOf(issue.id, lead, w.act[lead.act]);
    if (!primary) primary = { label: w.open, intent: { type: "open", issue: issue.id } };
    if (!secondary) {
      const other = acts.find((a) => a.act !== "close" && a.act !== lead?.act);
      secondary = other ? choiceOf(issue.id, other, w.act[other.act]) : { label: w.open, intent: { type: "open", issue: issue.id } };
    }
    out.push({ id: item.id, kind: item.kind, title: issue.title, source: item.who, atMs: item.at, detail, primary, secondary });
  }
  return out;
}

/** Permission requests in an agent's events that are not answered yet. */
export function decisionsFromEvents(events: AgentEvent[], session?: { id: string; name: string }): Decision[] {
  const open = new Map<string, Decision>();
  for (const e of events) {
    const k = e.kind;
    if (k.type === "permission_requested") {
      const input = k.input as Record<string, unknown> | null;
      const command = input && typeof input.command === "string" ? input.command : null;
      open.set(k.request_id, {
        id: `${session?.id ?? "session"}:${k.request_id}`,
        kind: "permission",
        title: k.summary || `Use ${k.tool}`,
        source: session?.name ?? k.tool,
        atMs: e.at_ms,
        detail: command ?? (input ? JSON.stringify(input, null, 2) : null),
        primary: { label: "Allow", intent: { type: "permission", session: session?.id, request_id: k.request_id, decision: "AllowOnce" }, done: "Allowed" },
        secondary: {
          label: "Deny",
          intent: { type: "permission", session: session?.id, request_id: k.request_id, decision: { Deny: { message: null } } },
          done: "Denied",
        },
      });
    } else if (k.type === "permission_resolved") {
      open.delete(k.request_id);
    }
  }
  return [...open.values()];
}

// ---- The view ----

/** "3 need your input" with the user's locale digits; the header is the live region. */
export function countLabel(n: number): string {
  if (n === 0) return "All caught up";
  return `${n.toLocaleString()} ${n === 1 ? "needs" : "need"} your input`;
}

function timeAgo(atMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - atMs) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function AlertMark(props: { color: string }) {
  return (
    <View
      accessibilityElementsHidden
      style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: props.color, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ fontSize: 11, lineHeight: 12, fontWeight: "700", color: "#ffffff" }}>!</Text>
    </View>
  );
}

function DoneMark(props: { color: string }) {
  return (
    <View
      accessibilityElementsHidden
      style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: props.color, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ fontSize: 10, lineHeight: 12, fontWeight: "700", color: "#ffffff" }}>✓</Text>
    </View>
  );
}

const focusRing = () => ({ outlineWidth: 2, outlineColor: tok().focus, outlineOffset: 2, outlineStyle: "solid" as const });

/** The dark gradient button; inverted in dark mode. */
export function PrimaryButton(props: { label: string; onPress: () => void; testID?: string }) {
  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      style={{
        minHeight: 30,
        maxWidth: "100%",
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: radius.button,
        justifyContent: "center",
        backgroundImage: dark() ? "linear-gradient(to bottom, #f4f4f5, #e4e4e7)" : "linear-gradient(to bottom, #323137, #201e25)",
        boxShadow: dark()
          ? [
              { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(0,0,0,0.6)", inset: false },
              { x: 0, y: 2, blur: 4, spread: 0, color: "rgba(0,0,0,0.3)", inset: false },
            ]
          : [
              { x: 0, y: 0, blur: 0, spread: 1, color: "#0d0d0d", inset: false },
              { x: 0, y: 2, blur: 4, spread: 0, color: "rgba(0,0,0,0.1)", inset: false },
              { x: 0, y: 1, blur: 0, spread: 0, color: "rgba(255,255,255,0.12)", inset: true },
            ],
        transitionProperty: "colors,transform",
        transitionDuration: ms(durations.press),
        transitionTimingFunction: "ease",
      }}
      activeStyle={{ transform: [{ scale: 0.98 }] }}
      focusVisibleStyle={focusRing()}
    >
      <Text style={{ fontSize: 13, lineHeight: 20, fontWeight: "500", color: p().onPrimary, writingDirection: "auto" }}>{props.label}</Text>
    </View>
  );
}

/** The light ringed button. */
export function SecondaryButton(props: { label: string; onPress: () => void; testID?: string }) {
  const p = () => tok();
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      style={{
        minHeight: 30,
        maxWidth: "100%",
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: radius.button,
        justifyContent: "center",
        backgroundColor: p().surface,
        boxShadow: [
          { x: 0, y: 0, blur: 0, spread: 1, color: p().border, inset: false },
          { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0,0,0,0.04)", inset: false },
        ],
        transitionProperty: "colors,transform",
        transitionDuration: ms(durations.press),
        transitionTimingFunction: "ease",
      }}
      hoverStyle={{ backgroundColor: p().subtle }}
      activeStyle={{ transform: [{ scale: 0.98 }] }}
      focusVisibleStyle={focusRing()}
    >
      <Text style={{ fontSize: 13, lineHeight: 20, fontWeight: "500", color: p().ink, writingDirection: "auto" }}>{props.label}</Text>
    </View>
  );
}

function Row(props: {
  entry: Decision;
  first: boolean;
  open: boolean;
  answered: string | null;
  now: number;
  onOpen: () => void;
  onDecide: (choice: "primary" | "secondary") => void;
}) {
  const p = () => tok();
  const meta = () => [props.entry.source, timeAgo(props.entry.atMs, props.now)].filter(Boolean).join(" · ");
  const done = createMotion();
  effect(() => {
    if (props.answered && !reduceMotion()) void done.play({ duration: durations.statusSwap, keyframes: { opacity: [0, 1], translateY: [3, 0] } });
  });
  return (
    <View
      testID={`decision-${props.entry.id}`}
      style={{ borderTopWidth: props.first ? 0 : 1, borderTopColor: p().border, paddingHorizontal: 20, paddingTop: 16, paddingBottom: props.open ? 14 : 16 }}
    >
      {props.open ? (
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: "500", color: p().ink, writingDirection: "auto" }}>{props.entry.title}</Text>
          <Text style={{ ...ty.label, color: p().muted, numberOfLines: 1 }}>{meta()}</Text>
        </View>
      ) : (
        <View
          onPress={props.onOpen}
          role="button"
          accessibilityLabel={props.entry.title}
          accessibilityState={{ expanded: false }}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          focusVisibleStyle={focusRing()}
        >
          <Text
            style={{
              fontSize: 14,
              lineHeight: 20,
              fontWeight: "500",
              color: p().faint,
              numberOfLines: 1,
              flex: 1,
              minWidth: 0,
              writingDirection: "auto",
              transitionProperty: "colors",
              transitionDuration: ms(durations.press),
            }}
            hoverStyle={{ color: p().muted }}
          >
            {props.entry.title}
          </Text>
          <Text style={{ ...ty.label, color: p().faint, fontVariant: ["tabular-nums"], flexShrink: 0 }}>{timeAgo(props.entry.atMs, props.now)}</Text>
        </View>
      )}
      {props.open ? (
        <View style={{ gap: 12, marginTop: 4 }}>
          {props.entry.detail ? (
            <Text style={{ fontSize: 13, lineHeight: 20, color: p().muted, numberOfLines: 6, writingDirection: "auto", userSelect: "text" }}>
              {props.entry.detail}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, minHeight: 30 }}>
            {props.answered ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, ...done.style }}>
                <DoneMark color={p().ok} />
                <Text style={{ fontSize: 13, lineHeight: 20, fontWeight: "500", color: p().ok, writingDirection: "auto" }}>{props.answered}</Text>
              </View>
            ) : (
              <>
                <PrimaryButton label={props.entry.primary.label} onPress={() => props.onDecide("primary")} testID="decide-primary" />
                {props.entry.secondary ? (
                  <SecondaryButton label={props.entry.secondary.label} onPress={() => props.onDecide("secondary")} testID="decide-secondary" />
                ) : null}
              </>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function DecisionInbox(props: DecisionInboxProps) {
  const p = () => tok();
  const opened = signal<Set<string>>(new Set());
  const answered = signal<Record<string, string>>({});
  /** Rows folded away after their confirmation; they stay gone even if the frame still lists them. */
  const gone = signal<Set<string>>(new Set());
  /** Answered rows the frame dropped already stay until their fold. */
  const holding = signal<Decision[]>([]);
  const now = signal(Date.now());
  const tick = setInterval(() => now.set(Date.now()), 30_000);
  const timers: number[] = [];
  cleanup(() => {
    clearInterval(tick);
    timers.forEach(clearTimeout);
  });

  const shown = () => {
    const ids = new Set(props.entries.map((e) => e.id));
    return [...props.entries, ...holding().filter((e) => !ids.has(e.id))].filter((e) => !gone().has(e.id));
  };
  const waiting = () => shown().filter((e) => !answered()[e.id]).length;
  const isOpen = (e: Decision, i: number) => opened().has(e.id) || !!answered()[e.id] || i < (props.openFirst ?? 1);

  let lastCount = untracked(waiting);
  effect(() => {
    const n = waiting();
    untracked(() => {
      if (n !== lastCount) announce(countLabel(n));
      lastCount = n;
    });
  });

  const decide = (entry: Decision, choice: "primary" | "secondary") => {
    const picked = choice === "primary" ? entry.primary : entry.secondary;
    props.onDecide(entry, choice);
    if (!picked?.done) return;
    announce(picked.done);
    answered.set({ ...answered(), [entry.id]: picked.done });
    holding.set([...holding().filter((e) => e.id !== entry.id), entry]);
    timers.push(
      setTimeout(
        () => {
          animateLayout(durations.foldHeight);
          const rest = shown().filter((e) => e.id !== entry.id && !answered()[e.id] && !opened().has(e.id));
          const next = new Set(opened());
          if (rest.length > 0) next.add(rest[0].id);
          opened.set(next);
          gone.set(new Set([...gone(), entry.id]));
          holding.set(holding().filter((e) => e.id !== entry.id));
        },
        ms(durations.foldHold) || 0,
      ),
    );
  };

  const clear = () => waiting() === 0;
  return (
    <View testID="decision-inbox" style={{ backgroundColor: p().subtle, padding: 6, borderRadius: radius.tray, maxWidth: 520, width: "100%" }}>
      <View
        accessible
        accessibilityLabel={countLabel(waiting())}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 11, paddingBottom: 10, paddingHorizontal: 18 }}
      >
        {clear() ? <DoneMark color={p().ok} /> : <AlertMark color={p().alert} />}
        <Text
          style={{
            fontSize: 14,
            lineHeight: 20,
            fontWeight: "500",
            color: clear() ? p().ok : p().alert,
            fontVariant: ["tabular-nums"],
            transitionProperty: "colors",
            transitionDuration: ms(300),
            transitionTimingFunction: ease,
          }}
        >
          {countLabel(waiting())}
        </Text>
      </View>
      <View
        style={{
          backgroundColor: p().surface,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: p().border,
          boxShadow: [{ x: 0, y: 1, blur: 2, spread: 0, color: colorScheme() === "dark" ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.06)", inset: false }],
          overflow: "hidden",
        }}
      >
        <Each of={shown()} key={(e) => e.id}>
          {(entry, i) => (
            <Row
              entry={entry()}
              first={i() === 0}
              open={isOpen(entry(), i())}
              answered={answered()[entry().id] ?? null}
              now={now()}
              onOpen={() => {
                animateLayout(durations.expandHeight);
                opened.set(new Set([...opened(), entry().id]));
              }}
              onDecide={(choice) => decide(entry(), choice)}
            />
          )}
        </Each>
        {shown().length === 0 ? (
          <Text testID="decision-inbox-empty" style={{ fontSize: 13, lineHeight: 20, color: p().muted, paddingHorizontal: 20, paddingVertical: 18 }}>
            Nothing waiting on you – new decisions show up here.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
