import { z } from "zod";

import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface DebugHandlers {
  readonly "debug.snapshot": () => Promise<T.DebugSnapshot>;
  readonly "debug.timeline.list": (a: T.DebugTimelineQuery) => Promise<T.DebugTimelinePage>;
  readonly "debug.timeline.clear": () => Promise<void>;
  readonly "debug.trajectory.list": () => Promise<T.DebugTrajectorySummary[]>;
  readonly "debug.trajectory.get": (a: T.DebugTrajectoryGetRequest) => Promise<T.DebugTrajectoryDetail>;
  readonly "debug.graph": () => Promise<T.DebugGraph>;
  readonly "debug.override.get": () => Promise<T.DebugOverrideConfig>;
  readonly "debug.override.set": (a: T.DebugOverrideConfig) => Promise<T.DebugOverrideConfig>;
  readonly "debug.bundle.export": () => Promise<T.DebugBundleResult>;
}

export const debugEndpoints: readonly Endpoint[] = [
  {
    op: "debug.snapshot",
    about: [],
    input: undefined,
    result: S.DebugSnapshot,
    can: ["user"],
  },
  {
    op: "debug.timeline.list",
    about: [],
    input: S.DebugTimelineQuery,
    result: S.DebugTimelinePage,
    can: ["user"],
  },
  {
    op: "debug.timeline.clear",
    about: [],
    input: undefined,
    result: undefined,
    can: ["user"],
  },
  {
    op: "debug.trajectory.list",
    about: [],
    input: undefined,
    result: z.array(S.DebugTrajectorySummary),
    can: ["user"],
  },
  {
    op: "debug.trajectory.get",
    about: ["id"],
    input: S.DebugTrajectoryGetRequest,
    result: S.DebugTrajectoryDetail,
    can: ["user"],
  },
  {
    op: "debug.graph",
    about: [],
    input: undefined,
    result: S.DebugGraph,
    can: ["user"],
  },
  {
    op: "debug.override.get",
    about: [],
    input: undefined,
    result: S.DebugOverrideConfig,
    can: ["user"],
  },
  {
    op: "debug.override.set",
    about: [],
    input: S.DebugOverrideConfig,
    result: S.DebugOverrideConfig,
    can: ["user"],
  },
  {
    op: "debug.bundle.export",
    about: [],
    input: undefined,
    result: S.DebugBundleResult,
    can: ["user"],
  },
];
