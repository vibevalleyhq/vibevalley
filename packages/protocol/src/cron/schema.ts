import { z } from "zod";

import type { Codec } from "../codec";
import { ActorKind } from "../common/schema";
import type * as T from "./shapes";

const CronWhenOnce = z.object({
  kind: z.literal("once"),
  at: z.number(),
}) satisfies Codec<T.CronWhenOnce>;

const CronWhenEvery = z.object({
  kind: z.literal("every"),
  minutes: z.number(),
}) satisfies Codec<T.CronWhenEvery>;

const CronWhenDaily = z.object({
  kind: z.literal("daily"),
  time: z.string(),
}) satisfies Codec<T.CronWhenDaily>;

export const CronWhenWeekly = z.object({
  kind: z.literal("weekly"),
  days: z.array(z.number().int().min(0).max(6)),
  time: z.string(),
}) satisfies Codec<T.CronWhenWeekly>;

const CronWhenExpr = z.object({
  kind: z.literal("cron"),
  expr: z.string(),
}) satisfies Codec<T.CronWhenExpr>;

export const CronWhen = z.discriminatedUnion("kind", [CronWhenOnce, CronWhenEvery, CronWhenDaily, CronWhenWeekly, CronWhenExpr]) satisfies Codec<T.CronWhen>;

const cronFields = {
  id: z.string(),
  name: z.string(),
  text: z.string(),
  channel: z.string(),
  agent: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  when: CronWhen,
  tz: z.string(),
  enabled: z.boolean(),
  created: z.number(),
  lastRun: z.exactOptional(z.number()),
  by: ActorKind,
  pending: z.boolean(),
};

export const Cron = z.object(cronFields) satisfies Codec<T.Cron>;

export const CronView = z.object({ ...cronFields, whenText: z.string(), nextText: z.string() }) satisfies Codec<T.CronView>;

export const CronRequest = z.object({
  name: z.string(),
  text: z.string(),
  channel: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  when: CronWhen,
  tz: z.exactOptional(z.string()),
}) satisfies Codec<T.CronRequest>;

export const CronUpdate = z.object({
  enabled: z.exactOptional(z.boolean()),
}) satisfies Codec<T.CronUpdate>;

export const FactCronChanged = z.object({
  type: z.literal("cronChanged"),
  at: z.number(),
  cron: Cron,
}) satisfies Codec<T.FactCronChanged>;

export const FactCronRemoved = z.object({
  type: z.literal("cronRemoved"),
  at: z.number(),
  id: z.string(),
}) satisfies Codec<T.FactCronRemoved>;
