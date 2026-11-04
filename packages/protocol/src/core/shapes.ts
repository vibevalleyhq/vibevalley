// The shapes of the core state, its facts, the event streams and the frames the page reads (docs/subsystems/core.md).

import type { Channel, Chat, ChatMessage, OwnerMention } from "../channel/shapes";
import type { IssueId, Outcome, SessionId, Spent } from "../common/shapes";
import type { ConnectorStatus } from "../connector/shapes";
import type { Cron, CronView } from "../cron/shapes";
import type { CommitCount, FarmView, GameEffect, Progress, ProgressNews, SessionPlay } from "../game/shapes";
import type { InboxItem } from "../inbox/shapes";
import type { CriterionCheck, Issue, Question } from "../issue/shapes";
import type { RuntimeInfo } from "../runtime/shapes";
import type { IssueAnswer, Phase, PhaseResting, Session, SessionClose, SessionEvent, SessionView } from "../session/shapes";
import type { CallState } from "../voice/shapes";

/** Every endpoint is a POST at its op, named as in api.ts. */
export const pathOf = (op: string) => "/api/v1/" + op.replaceAll(".", "/");

/** The three long-lived streams; the client asks for them by path. */
export const statePath = "/api/v1/state";

export const eventsPath = "/api/v1/events";

export const livePath = "/api/v1/live";

/** The line the server prints on stdout once it listens, with --ready-json (the desktop shell waits for it). */
export interface ServerReady {
  url: string;
  pid: number;
}

export interface WorkspaceState {
  call: CallState;
  callReason: string;
  /** Each orchestrator not at rest, by its profile id, as its last orchestrator fact says; one not here is idle. */
  sessions: Session[];
  /** The farm's pixel-only station and step history, by session; no business rule reads it. */
  plays?: Record<string, SessionPlay>;
  chat?: Chat;
  commits?: CommitCount;
  progress?: Progress;
  crons: Cron[];
  issues: Issue[];
  /** Each chat app's status, as the connectors say it whenever it changes; their home is the connectors, not state.json. */
  connectors: ConnectorStatus[];
}

export interface WorkspaceView extends Omit<WorkspaceState, "sessions" | "crons" | "plays"> {
  sessions: SessionView[];
  crons: CronView[];
}

export const NoticeLevelValues = ["info", "warn", "error"] as const;
export type NoticeLevel = (typeof NoticeLevelValues)[number];

export interface StateFrame {
  /** Goes up by one with every commit the core folds (Core.apply that changed the state): this frame shows every fold up
   * to it. A reply carrying a seq (AppliedIssue) is shown by the first frame whose seq is at least that one. */
  seq: number;
  state: WorkspaceView;
  inbox: InboxItem[];
  view: FarmView;
  effects: GameEffect[];
}

export interface Health {
  ok: boolean;
  version: string;
}

/** Told apart by `type`. */
export type Fact =
  | FactCallChanged
  | FactSessionPhaseChanged
  | FactMessageChanged
  | FactChannelChanged
  | FactChannelRemoved
  | FactOwnerMentionsChanged
  | FactSessionChanged
  | FactSessionReported
  | FactSessionLeft
  | FactProgressChanged
  | FactIssueChanged
  | FactIssueRemoved
  | FactCronChanged
  | FactCronRemoved
  | FactConnectorChanged;

export interface FactCallChanged {
  type: "callChanged";
  at: number;
  state: CallState;
  reason: string;
}

export interface FactSessionPhaseChanged {
  type: "sessionPhaseChanged";
  at: number;
  id: SessionId;
  phase: Phase;
  channel?: string;
  spent?: Spent;
  brief?: string;
}

export interface FactMessageChanged {
  type: "messageChanged";
  at: number;
  message: ChatMessage;
  thread?: string;
  answers?: SessionId;
}

export interface FactChannelChanged {
  type: "channelChanged";
  at: number;
  channel: Channel;
}

/** A channel deleted, and its threads with it. */
export interface FactChannelRemoved {
  type: "channelRemoved";
  at: number;
  id: string;
}

export interface FactOwnerMentionsChanged {
  type: "ownerMentionsChanged";
  at: number;
  mentions: OwnerMention[];
}

export interface FactSessionChanged {
  type: "sessionChanged";
  at: number;
  session: Session;
}

export interface FactSessionReported {
  type: "sessionReported";
  at: number;
  id: SessionId;
  run?: string;
  outcome: Outcome;
  /** A successful turn can rest for external feedback without handing off to the owner. */
  phase?: PhaseResting;
  summary: string;
  runs: number;
  spent?: Spent;
  questions: Question[];
  checks: CriterionCheck[];
  answer?: IssueAnswer;
}

export interface FactSessionLeft {
  type: "sessionLeft";
  at: number;
  id: SessionId;
  closed?: SessionClose;
  merged?: number;
}

export interface FactIssueChanged {
  type: "issueChanged";
  at: number;
  issue: Issue;
}

export interface FactIssueRemoved {
  type: "issueRemoved";
  at: number;
  id: IssueId;
}

export interface FactProgressChanged {
  type: "progressChanged";
  at: number;
  progress?: Progress;
  news?: ProgressNews;
  commits?: CommitCount;
  station?: { readonly id: SessionId; readonly station: number };
}

export interface FactConnectorChanged {
  type: "connectorChanged";
  at: number;
  status: ConnectorStatus;
}

export interface FactCronChanged {
  type: "cronChanged";
  at: number;
  cron: Cron;
}

export interface FactCronRemoved {
  type: "cronRemoved";
  at: number;
  id: string;
}

/** Told apart by `type`. */
export type ServerEvent =
  | FactCallChanged
  | FactSessionPhaseChanged
  | FactMessageChanged
  | FactChannelChanged
  | FactChannelRemoved
  | FactOwnerMentionsChanged
  | FactSessionChanged
  | FactSessionReported
  | FactSessionLeft
  | FactProgressChanged
  | FactIssueChanged
  | FactIssueRemoved
  | FactCronChanged
  | FactCronRemoved
  | FactConnectorChanged
  | ServerEventSnapshot
  | ServerEventStep
  | ServerEventNotice
  | ServerEventRuntime;

export interface ServerEventSnapshot {
  type: "snapshot";
  at: number;
  state: WorkspaceState;
}

export interface ServerEventStep {
  type: "event";
  at: number;
  id: string;
  activity: SessionEvent;
}

export interface ServerEventNotice {
  type: "notice";
  at: number;
  level: NoticeLevel;
  text: string;
}

export interface ServerEventRuntime {
  type: "runtime";
  at: number;
  info: RuntimeInfo;
}

/** Told apart by `type`. */
export type LiveEvent = LiveEventSession | LiveEventNotice | LiveEventRuntime;

export interface LiveEventSession {
  type: "event";
  at: number;
  id: string;
  activity: SessionEvent;
}

export interface LiveEventNotice {
  type: "notice";
  at: number;
  level: NoticeLevel;
  text: string;
}

export interface LiveEventRuntime {
  type: "runtime";
  at: number;
  info: RuntimeInfo;
}
