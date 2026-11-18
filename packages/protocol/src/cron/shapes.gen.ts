// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ActorKind } from "../common/shapes.gen";

export type CronWhenOnce = { "kind": "once", at: number, };

export type CronWhenEvery = { "kind": "every", minutes: number, };

export type CronWhenDaily = { "kind": "daily", time: string, };

export type CronWhenWeekly = { "kind": "weekly", days: Array<number>, time: string, };

export type CronWhenExpr = { "kind": "cron", expr: string, };

/**
 * Told apart by `kind`.
 */
export type CronWhen = CronWhenOnce | CronWhenEvery | CronWhenDaily | CronWhenWeekly | CronWhenExpr;

export type Cron = { id: string, name: string, text: string, channel: string, agent?: string, repo?: string, when: CronWhen, tz: string, enabled: boolean, created: number, lastRun?: number, by: ActorKind, pending: boolean, };

export type CronView = { id: string, name: string, text: string, channel: string, agent?: string, repo?: string, when: CronWhen, tz: string, enabled: boolean, created: number, lastRun?: number, by: ActorKind, pending: boolean, whenText: string, nextText: string, };

export type CronRequest = { name: string, text: string, channel?: string, agent?: string, repo?: string, when: CronWhen, tz?: string, };

export type CronUpdate = { enabled?: boolean, };

export type FactCronChanged = { "type": "cronChanged", at: number, cron: Cron, };

export type FactCronRemoved = { "type": "cronRemoved", at: number, id: string, };

export type CronUpdateInput = { id: string, enabled?: boolean, };

export type CronDeleteInput = { id: string, };
