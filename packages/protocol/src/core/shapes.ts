import type { Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactOwnerMentionsChanged } from "../channel/shapes";
import type { ConnectorStatus, FactConnectorChanged } from "../connector/shapes";
import type { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/shapes";
import type { CommitCount, FactProgressChanged, FarmView, GameEffect, Progress, SessionPlay } from "../game/shapes";
import type { InboxItem } from "../inbox/shapes";
import type { FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue } from "../issue/shapes";
import type { MediaJob, FactMediaChanged } from "../media/shapes";
import type { RuntimeInfo } from "../runtime/shapes";
import type {
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionChanged,
  FactSessionLeft,
  FactSessionPhaseChanged,
  Session,
  SessionEvent,
  SessionView,
} from "../session/shapes";
import type { CallState, FactCallChanged } from "../voice/shapes";

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

export interface SpaceState {
  call: CallState;
  callReason: string;
  media?: MediaJob[];
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

export interface SpaceView extends Omit<SpaceState, "sessions" | "crons" | "plays"> {
  sessions: SessionView[];
  crons: CronView[];
}

export const NoticeLevelValues = ["info", "warn", "error"] as const;
export type NoticeLevel = (typeof NoticeLevelValues)[number];

export interface StateFrame {
  /** Goes up by one with every commit the core folds (Core.apply that changed the state): this frame shows every fold up to it. */
  seq: number;
  state: SpaceView;
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
  | FactSessionToolChanged
  | FactSessionToolsReset
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
  | FactMediaChanged;

/** Told apart by `type`. */
export type ServerEvent = Fact | ServerEventSnapshot | ServerEventStep | ServerEventNotice | ServerEventRuntime;

export interface ServerEventSnapshot {
  type: "snapshot";
  at: number;
  state: SpaceState;
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
