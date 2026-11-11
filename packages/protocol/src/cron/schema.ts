import { Schema } from "effect";

import type { Codec } from "../codec";
import { ActorKind } from "../common/schema";
import type * as T from "./shapes";

const CronWhenOnce: Codec<T.CronWhenOnce> = Schema.Struct({
  kind: Schema.Literal("once"),
  at: Schema.Finite,
});

const CronWhenEvery: Codec<T.CronWhenEvery> = Schema.Struct({
  kind: Schema.Literal("every"),
  minutes: Schema.Finite,
});

const CronWhenDaily: Codec<T.CronWhenDaily> = Schema.Struct({
  kind: Schema.Literal("daily"),
  time: Schema.String,
});

export const CronWhenWeekly: Codec<T.CronWhenWeekly> = Schema.Struct({
  kind: Schema.Literal("weekly"),
  days: Schema.mutable(Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })))),
  time: Schema.String,
});

const CronWhenExpr: Codec<T.CronWhenExpr> = Schema.Struct({
  kind: Schema.Literal("cron"),
  expr: Schema.String,
});

export const CronWhen: Codec<T.CronWhen> = Schema.Union([CronWhenOnce, CronWhenEvery, CronWhenDaily, CronWhenWeekly, CronWhenExpr]);

const cronFields = {
  id: Schema.String,
  name: Schema.String,
  text: Schema.String,
  channel: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  when: CronWhen,
  tz: Schema.String,
  enabled: Schema.Boolean,
  created: Schema.Finite,
  lastRun: Schema.optionalKey(Schema.Finite),
  by: ActorKind,
  pending: Schema.Boolean,
};

export const Cron: Codec<T.Cron> = Schema.Struct(cronFields);

export const CronView: Codec<T.CronView> = Schema.Struct({ ...cronFields, whenText: Schema.String, nextText: Schema.String });

export const CronRequest: Codec<T.CronRequest> = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
  channel: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  when: CronWhen,
  tz: Schema.optionalKey(Schema.String),
});

export const CronUpdate: Codec<T.CronUpdate> = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const FactCronChanged: Codec<T.FactCronChanged> = Schema.Struct({
  type: Schema.Literal("cronChanged"),
  at: Schema.Finite,
  cron: Cron,
});

export const FactCronRemoved: Codec<T.FactCronRemoved> = Schema.Struct({
  type: Schema.Literal("cronRemoved"),
  at: Schema.Finite,
  id: Schema.String,
});
