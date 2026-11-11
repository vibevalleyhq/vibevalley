import { randomBytes } from "node:crypto";

import type { SubagentReport } from "@botiverse/oar/agents";
import { Effect, type Scope, type Semaphore } from "effect";

import type * as T from "@vibevalley/protocol";

import type { ExecutionInput } from "#/modules/machine/executor.ts";
import type { Workplace } from "#/modules/repo/workplace.ts";

import type { Journal } from "./journal.ts";
import type { Tracking } from "./reaction.ts";

export interface Hand {
  readonly id: T.SessionId;
  readonly scope: Scope.Closeable;
  readonly place: Workplace;
  /** Retained for run attribution even while the session is between assignments. */
  readonly issue: string;
  readonly access: Semaphore.Semaphore;
  readonly journal: Journal;
  /** `""` between launches. */
  oarSessionId: string;
  lastText: string;
  tracking: Tracking;
  /** `<id>#<n>`, or `""` when detached. */
  launch: string;
  spoke: boolean;
  /** Cleared to `""` on leave. */
  token: string;
  recalled: Set<string>;
  triggers: { readonly trigger: T.RunTrigger; readonly envelopeIds: readonly string[]; readonly inputId?: string }[];
  readonly inputs: Map<string, readonly string[]>;
  run: string;
  heard: string[];
  report: T.IssueReport | undefined;
  settling?: { readonly report: SubagentReport; readonly completedBefore: number };
}

export type PendingInputEffect = ExecutionInput;

/** Owns live `Hand` entries, MCP bearer tokens, and the `hand.access -> admission` lock order. */
export function makeHandRoster(admission: Semaphore.Semaphore) {
  const byId = new Map<string, Hand>();
  const tokens = new Map<string, string>();

  const revokeToken = (hand: Hand) => {
    tokens.delete(hand.token);
    hand.token = "";
  };

  const issueToken = (hand: Hand) => {
    revokeToken(hand);
    const token = "hb_" + hand.id + "_" + randomBytes(18).toString("base64url");
    hand.token = token;
    tokens.set(token, hand.id);
    return token;
  };

  const withHand = <A, E>(id: string, onMissing: () => Effect.Effect<A, E>, use: (hand: Hand) => Effect.Effect<A, E>): Effect.Effect<A, E> => {
    const hand = byId.get(id);
    if (!hand) return onMissing();
    return hand.access.withPermits(1)(Effect.suspend(() => (byId.get(id) === hand ? use(hand) : onMissing())));
  };

  const withHandAndAdmission = <A, E>(id: string, onMissing: () => Effect.Effect<A, E>, use: (hand: Hand) => Effect.Effect<A, E>): Effect.Effect<A, E> => {
    const hand = byId.get(id);
    if (!hand) return onMissing();
    return Effect.suspend(() => (byId.get(id) === hand ? use(hand) : onMissing())).pipe(admission.withPermits(1), hand.access.withPermits(1));
  };

  return {
    get: (id: string) => byId.get(id),
    has: (id: string) => byId.has(id),
    get size() {
      return byId.size;
    },
    values: (): readonly Hand[] => [...byId.values()],
    set: (hand: Hand) => {
      byId.set(hand.id, hand);
    },
    delete: (hand: Hand) => {
      if (byId.get(hand.id) === hand) byId.delete(hand.id);
    },
    withHand,
    withHandAndAdmission,
    issueToken,
    revokeToken,
    clearTokens: () => tokens.clear(),
    who: (token: string) => tokens.get(token) ?? "",
  };
}

export type HandRoster = ReturnType<typeof makeHandRoster>;
