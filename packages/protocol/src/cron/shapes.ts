import type { ActorKind } from "../common/shapes";

/** Told apart by `kind`. */
export type CronWhen = CronWhenOnce | CronWhenEvery | CronWhenDaily | CronWhenWeekly | CronWhenExpr;

export interface Cron {
  id: string;
  name: string;
  text: string;
  channel: string;
  agent?: string;
  project?: string;
  when: CronWhen;
  tz: string;
  enabled: boolean;
  created: number;
  lastRun?: number;
  by: ActorKind;
  pending: boolean;
}

export interface CronView extends Cron {
  whenText: string;
  nextText: string;
}

export interface CronRequest {
  name: string;
  text: string;
  channel?: string;
  agent?: string;
  project?: string;
  when: CronWhen;
  tz?: string;
}

export interface CronWhenOnce {
  kind: "once";
  at: number;
}

export interface CronWhenEvery {
  kind: "every";
  minutes: number;
}

export interface CronWhenDaily {
  kind: "daily";
  time: string;
}

export interface CronWhenWeekly {
  kind: "weekly";
  days: number[];
  time: string;
}

export interface CronWhenExpr {
  kind: "cron";
  expr: string;
}

export interface CronUpdate {
  enabled?: boolean;
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
